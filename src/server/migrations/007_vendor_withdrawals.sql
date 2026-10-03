-- Savora Food — vendor earnings withdrawal via Paystack Transfers
-- Additive only. Extends 006_dispatch_delivery.sql.
--
-- Design:
-- * vendor_wallets holds per-vendor pending/available balances in kobo
--   (BIGINT integers — never floats). Every mutation takes the wallet row
--   with SELECT ... FOR UPDATE inside a DB transaction (see src/server/wallet.ts).
-- * vendor_wallet_entries is the immutable ledger: rows are only ever
--   INSERTed, never UPDATEd/DELETEd by application code. balance_after_kobo
--   lets any balance be recomputed/audited by replaying the ledger.
-- * vendor_withdrawals tracks one row per vendor withdrawal request. The
--   `reference` (our idempotency key) is generated server-side with crypto
--   randomness and stored BEFORE any Paystack call. `idempotency_key`
--   dedupes double-clicks/retries at the DB level (UNIQUE).
-- * paystack_webhook_events dedupes webhook deliveries so replays are no-ops.
-- * Historical earnings (order_settlements PAYABLE + legacy vendor_payouts)
--   are backfilled into wallets once, as a single ADJUSTMENT entry per
--   vendor, so existing vendors keep their earned balance.

-- ── Withdrawal requests (one row per vendor-initiated payout) ──
CREATE TABLE IF NOT EXISTS vendor_withdrawals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount_kobo           BIGINT NOT NULL CHECK (amount_kobo > 0),
  recipient_code        TEXT NOT NULL,
  bank_code             TEXT,
  account_number        TEXT,
  account_name          TEXT,
  reference             TEXT NOT NULL UNIQUE,
  paystack_transfer_code TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED', 'OTP')),
  failure_reason        TEXT,
  idempotency_key       TEXT NOT NULL UNIQUE,
  approved_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_vendor ON vendor_withdrawals (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_reference ON vendor_withdrawals (reference);
CREATE INDEX IF NOT EXISTS idx_vendor_withdrawals_idempotency ON vendor_withdrawals (idempotency_key);

-- ── Per-vendor wallet (kobo integers; locked with FOR UPDATE on mutation) ──
CREATE TABLE IF NOT EXISTS vendor_wallets (
  vendor_id       UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  available_kobo  BIGINT NOT NULL DEFAULT 0 CHECK (available_kobo >= 0),
  pending_kobo    BIGINT NOT NULL DEFAULT 0 CHECK (pending_kobo >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Immutable wallet ledger (INSERT-only from application code) ──
CREATE TABLE IF NOT EXISTS vendor_wallet_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id          UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
    CHECK (kind IN ('CREDIT_HOLD', 'HOLD_RELEASE', 'WITHDRAW_LOCK', 'WITHDRAW_REVERSAL', 'ADJUSTMENT')),
  amount_kobo        BIGINT NOT NULL,
  balance_after_kobo BIGINT NOT NULL,
  order_id           UUID REFERENCES orders(id) ON DELETE SET NULL,
  withdrawal_id      UUID REFERENCES vendor_withdrawals(id) ON DELETE SET NULL,
  meta               JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_entries_vendor ON vendor_wallet_entries (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_order ON vendor_wallet_entries (order_id);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_withdrawal ON vendor_wallet_entries (withdrawal_id);

-- One HOLD credit per order: prevents double-crediting the same DELIVERED order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_order_hold
  ON vendor_wallet_entries (order_id, kind)
  WHERE order_id IS NOT NULL AND kind = 'CREDIT_HOLD';

-- ── Webhook delivery log (idempotency for transfer.* replays) ──
CREATE TABLE IF NOT EXISTS paystack_webhook_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key   TEXT NOT NULL UNIQUE,
  event       TEXT NOT NULL,
  reference   TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_reference ON paystack_webhook_events (reference);

-- ── Vendor bank / recipient fields (Paystack transfer recipient) ──
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS recipient_code TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_code TEXT;

-- ── Withdrawal policy defaults (hold period, min/max, auto-approve threshold) ──
-- Amounts here are kobo integers. Hold: earnings unlock 48h after delivery.
UPDATE platform_settings
SET value = value || '{"hold_days":2,"min_withdrawal_kobo":100000,"max_withdrawal_kobo":50000000,"auto_approve_below_kobo":5000000}',
    updated_at = NOW()
WHERE key = 'payout_config';

INSERT INTO platform_settings (key, value) VALUES
  ('payout_config', '{"vendor_commission_pct":10,"rider_share_of_delivery_fee_pct":100,"platform_keeps_service_fee":true,"platform_keeps_tax":false,"hold_days":2,"min_withdrawal_kobo":100000,"max_withdrawal_kobo":50000000,"auto_approve_below_kobo":5000000}')
ON CONFLICT (key) DO NOTHING;

-- ── Backfill: one wallet row per vendor ──
INSERT INTO vendor_wallets (vendor_id, available_kobo, pending_kobo)
SELECT v.id, 0, 0 FROM vendors v
ON CONFLICT (vendor_id) DO NOTHING;

-- Backfill earned balance from settlement ledger minus legacy paid-out payouts.
-- Conservative: only PAYABLE settlements count; PENDING settlements are still
-- in-flight. Floored at zero so legacy over-payment can never mint money.
WITH earned AS (
  SELECT vendor_id, COALESCE(SUM(vendor_net), 0) AS net_naira
  FROM order_settlements
  WHERE status = 'PAYABLE'
  GROUP BY vendor_id
),
paid AS (
  SELECT vendor_id, COALESCE(SUM(net_amount), 0) AS paid_naira
  FROM vendor_payouts
  WHERE status = 'PAID'
  GROUP BY vendor_id
),
opening AS (
  SELECT v.id AS vendor_id,
         GREATEST(0, ROUND((COALESCE(e.net_naira, 0) - COALESCE(p.paid_naira, 0)) * 100))::BIGINT AS opening_kobo
  FROM vendors v
  LEFT JOIN earned e ON e.vendor_id = v.id
  LEFT JOIN paid p ON p.vendor_id = v.id
)
UPDATE vendor_wallets w
SET available_kobo = o.opening_kobo, updated_at = NOW()
FROM opening o
WHERE w.vendor_id = o.vendor_id AND o.opening_kobo > 0;

-- One ADJUSTMENT ledger entry per backfilled wallet, so the opening balance
-- is explainable by replaying the ledger.
INSERT INTO vendor_wallet_entries (vendor_id, kind, amount_kobo, balance_after_kobo, meta)
SELECT w.vendor_id, 'ADJUSTMENT', w.available_kobo, w.available_kobo,
       '{"reason":"opening_balance_backfill","source":"order_settlements_minus_vendor_payouts"}'
FROM vendor_wallets w
WHERE w.available_kobo > 0
  AND NOT EXISTS (
    SELECT 1 FROM vendor_wallet_entries e
    WHERE e.vendor_id = w.vendor_id AND e.kind = 'ADJUSTMENT'
  );
