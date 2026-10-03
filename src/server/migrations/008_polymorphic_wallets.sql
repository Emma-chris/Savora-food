-- Savora Food — polymorphic payout wallets (vendors + riders)
-- Extends 007_vendor_withdrawals.sql. Generalizes the vendor-only wallet
-- rail to any owner type WITHOUT duplicating tables or service code.
--
-- Approach: rename the 007 tables to generic names, replace vendor_id with
-- (owner_type, owner_id), and migrate existing rows to owner_type='VENDOR'.
-- Trade-off: the owner FK can no longer point at a single table (polymorphic
-- owners can't share one FK), so ownership is enforced at the app layer
-- (requireVendor/getVendorContext, requireRider/getRiderByUserId) plus the
-- ownerMatches() guard in src/server/wallet.ts. All balance mutations still
-- run in locked transactions.

-- ── wallets (was vendor_wallets) ──
ALTER TABLE IF EXISTS vendor_wallets RENAME TO wallets;
ALTER TABLE wallets RENAME COLUMN vendor_id TO owner_id;
-- The old vendor FK cannot span two owner tables; ownership is enforced at
-- the app layer (session-derived owners + assertOwner). Drop it so rider rows
-- can exist. Vendor rows stay valid because their owner ids are vendors.id.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS vendor_wallets_vendor_id_fkey;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_vendor_id_fkey;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'VENDOR'
  CHECK (owner_type IN ('VENDOR', 'RIDER'));
-- Backfill safety: every pre-existing row is a vendor wallet.
UPDATE wallets SET owner_type = 'VENDOR' WHERE owner_type IS NULL OR owner_type = '';
-- Composite PK: one wallet per (type, id).
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS vendor_wallets_pkey;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_pkey;
ALTER TABLE wallets ADD CONSTRAINT wallets_pkey PRIMARY KEY (owner_type, owner_id);
-- Penalties may push a rider balance below zero (withdrawals stay blocked
-- until it is positive again), so the non-negative check on available is
-- dropped. Pending holds can never go negative.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS vendor_wallets_available_kobo_check;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_available_kobo_check;

-- ── wallet_entries (was vendor_wallet_entries): immutable ledger ──
ALTER TABLE IF EXISTS vendor_wallet_entries RENAME TO wallet_entries;
ALTER TABLE wallet_entries RENAME COLUMN vendor_id TO owner_id;
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS vendor_wallet_entries_vendor_id_fkey;
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_vendor_id_fkey;
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'VENDOR'
  CHECK (owner_type IN ('VENDOR', 'RIDER'));
UPDATE wallet_entries SET owner_type = 'VENDOR' WHERE owner_type IS NULL OR owner_type = '';
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL;

-- Normalize legacy kind names to the shared entry-type vocabulary, keeping
-- the original value inside meta for audit continuity.
UPDATE wallet_entries SET meta = COALESCE(meta, '{}') || jsonb_build_object('legacy_kind', kind)
  WHERE meta IS NULL OR NOT (meta ? 'legacy_kind');
UPDATE wallet_entries SET kind = 'hold' WHERE kind = 'CREDIT_HOLD';
UPDATE wallet_entries SET kind = 'release' WHERE kind = 'HOLD_RELEASE';
UPDATE wallet_entries SET kind = 'withdrawal' WHERE kind = 'WITHDRAW_LOCK';
UPDATE wallet_entries SET kind = 'withdrawal_reversal' WHERE kind = 'WITHDRAW_REVERSAL';
UPDATE wallet_entries SET kind = 'adjustment' WHERE kind = 'ADJUSTMENT';

ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS vendor_wallet_entries_kind_check;
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN (
  'hold', 'release', 'withdrawal', 'withdrawal_reversal', 'adjustment',
  'delivery_fee', 'tip', 'bonus', 'penalty'
));

-- Old per-order hold uniqueness, re-expressed on the new vocabulary.
DROP INDEX IF EXISTS idx_wallet_entries_order_hold;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_order_hold
  ON wallet_entries (order_id, kind)
  WHERE order_id IS NOT NULL AND kind = 'hold';

-- Exactly one credit entry of each kind per delivery (delivery_fee, tip,
-- bonus, penalty). This is what makes double-completion and double-tip
-- safe: the second INSERT is a no-op via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_delivery_entry
  ON wallet_entries (delivery_id, kind)
  WHERE delivery_id IS NOT NULL AND kind IN ('delivery_fee', 'tip', 'bonus', 'penalty');

CREATE INDEX IF NOT EXISTS idx_wallet_entries_owner ON wallet_entries (owner_type, owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_delivery ON wallet_entries (delivery_id);

-- ── withdrawals (was vendor_withdrawals) ──
ALTER TABLE IF EXISTS vendor_withdrawals RENAME TO withdrawals;
ALTER TABLE withdrawals RENAME COLUMN vendor_id TO owner_id;
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS vendor_withdrawals_vendor_id_fkey;
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_vendor_id_fkey;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'VENDOR'
  CHECK (owner_type IN ('VENDOR', 'RIDER'));
UPDATE withdrawals SET owner_type = 'VENDOR' WHERE owner_type IS NULL OR owner_type = '';
CREATE INDEX IF NOT EXISTS idx_withdrawals_owner ON withdrawals (owner_type, owner_id, created_at DESC);

-- ── Stored rider fee: computed ONCE at delivery completion, never recalculated ──
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS rider_fee_kobo BIGINT CHECK (rider_fee_kobo IS NULL OR rider_fee_kobo >= 0);

-- ── Rider payout account (mirrors vendors.recipient_code / bank_*) ──
ALTER TABLE delivery_partners ADD COLUMN IF NOT EXISTS recipient_code TEXT;
ALTER TABLE delivery_partners ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE delivery_partners ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE delivery_partners ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE delivery_partners ADD COLUMN IF NOT EXISTS bank_account_name TEXT;
ALTER TABLE delivery_partners ADD COLUMN IF NOT EXISTS payout_account_changed_at TIMESTAMPTZ;

-- ── Cooling-period clock for both owner types ──
-- After a bank-account change, withdrawals are blocked for
-- bank_change_cooling_hours (default 24h): stolen-session + swapped-account
-- is the classic payout-fraud pattern, and cooling gives the real owner time
-- to notice and report.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payout_account_changed_at TIMESTAMPTZ;

-- ── Per-owner-type payout policy ──
-- rider_hold_days / rider_min_withdrawal_kobo / rider_auto_approve_below_kobo:
-- riders earn per-trip and expect faster, smaller payouts than vendors.
-- cancelled_pickup_fee_pct: share of the computed rider fee credited when a
-- delivery is cancelled AFTER pickup (ASSUMPTION — see final report).
-- bank_change_cooling_hours: withdrawal block after payout-account changes.
UPDATE platform_settings
SET value = value || '{"rider_hold_days":1,"rider_min_withdrawal_kobo":100000,"rider_max_withdrawal_kobo":50000000,"rider_auto_approve_below_kobo":5000000,"bank_change_cooling_hours":24,"cancelled_pickup_fee_pct":50}',
    updated_at = NOW()
WHERE key = 'payout_config';

-- ── Backfill rider wallets + opening balances from delivered-trip history ──
-- ASSUMPTION (flagged in final report): historical rider earnings are
-- recomputed with the CURRENT rider-share config; no prior rider payouts
-- exist (there was no rider payout rail), so the full recomputed sum opens
-- the wallet. Floored at zero; one ADJUSTMENT entry per rider for audit.
INSERT INTO wallets (owner_type, owner_id, available_kobo, pending_kobo)
SELECT 'RIDER', dp.id, 0, 0 FROM delivery_partners dp
ON CONFLICT (owner_type, owner_id) DO NOTHING;

WITH cfg AS (
  SELECT COALESCE((value->>'rider_share_of_delivery_fee_pct')::numeric, 100) AS share_pct
  FROM platform_settings WHERE key = 'payout_config'
),
earned AS (
  SELECT d.delivery_partner_id AS rider_id,
         COALESCE(SUM(ROUND(o.delivery_fee * (SELECT share_pct FROM cfg) / 100) * 100), 0)::BIGINT AS net_kobo
  FROM deliveries d
  JOIN orders o ON o.id = d.order_id
  WHERE d.status = 'DELIVERED' AND d.delivery_partner_id IS NOT NULL
  GROUP BY d.delivery_partner_id
)
UPDATE wallets w
SET available_kobo = GREATEST(w.available_kobo, e.net_kobo), updated_at = NOW()
FROM earned e
WHERE w.owner_type = 'RIDER' AND w.owner_id = e.rider_id AND e.net_kobo > 0;

INSERT INTO wallet_entries (owner_type, owner_id, kind, amount_kobo, balance_after_kobo, meta)
SELECT w.owner_type, w.owner_id, 'adjustment', w.available_kobo, w.available_kobo,
       '{"reason":"opening_balance_backfill","source":"delivered_deliveries_times_current_rider_share"}'
FROM wallets w
WHERE w.owner_type = 'RIDER' AND w.available_kobo > 0
  AND NOT EXISTS (
    SELECT 1 FROM wallet_entries e
    WHERE e.owner_type = w.owner_type AND e.owner_id = w.owner_id AND e.kind = 'adjustment'
  );
