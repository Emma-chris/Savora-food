import { randomBytes, randomUUID } from "crypto";
import { db } from "./db";
import { ApiError } from "./errors";
import { getPayoutConfig } from "./money";

/**
 * Vendor wallet + withdrawal state machine.
 *
 * Money is stored as BIGINT kobo integers — never floats. Every balance
 * mutation runs inside a DB transaction that locks the wallet row with
 * SELECT ... FOR UPDATE, so concurrent withdrawals cannot overdraw.
 *
 * The webhook (transfer.success/failed/reversed) is the source of truth for
 * final withdrawal status — never the initiate-transfer response.
 */

// ── Pure policy (unit-testable, no DB) ─────────────────────────────────────

export const WITHDRAWAL_LIMITS = {
  /** Earnings unlock this many days after delivery (hold absorbs refunds/chargebacks). */
  holdDays: 2,
  /** Minimum single withdrawal: ₦1,000 in kobo. Rejects dust/test spam. */
  minWithdrawalKobo: 100_000,
  /** Maximum single withdrawal: ₦500,000 in kobo. Caps blast radius of a compromised session. */
  maxWithdrawalKobo: 50_000_000,
  /** At or below ₦50,000: execute immediately. Above: park as PENDING for admin approval. */
  autoApproveBelowKobo: 5_000_000,
} as const;

export type WithdrawalStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "REVERSED" | "OTP";

const TERMINAL_STATUSES: ReadonlySet<WithdrawalStatus> = new Set(["SUCCESS", "FAILED", "REVERSED"]);

/** Terminal states are final — a replayed webhook for one of these is a no-op. */
export function isTerminalWithdrawalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as WithdrawalStatus);
}

/** Naira float → kobo int. Central choke point so floats never reach the DB. */
export function nairaToKobo(naira: number): number {
  if (!Number.isFinite(naira) || naira < 0) {
    throw ApiError.validation("Invalid amount.");
  }
  return Math.round(naira * 100);
}

export function koboToNaira(kobo: number): number {
  return Math.round(kobo) / 100;
}

export function validateWithdrawalAmount(amountKobo: number, availableKobo: number): void {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    throw ApiError.validation("Enter a valid withdrawal amount.");
  }
  if (amountKobo < WITHDRAWAL_LIMITS.minWithdrawalKobo) {
    throw ApiError.validation(
      `Minimum withdrawal is ₦${koboToNaira(WITHDRAWAL_LIMITS.minWithdrawalKobo).toLocaleString()}.`,
    );
  }
  if (amountKobo > WITHDRAWAL_LIMITS.maxWithdrawalKobo) {
    throw ApiError.validation(
      `Maximum withdrawal is ₦${koboToNaira(WITHDRAWAL_LIMITS.maxWithdrawalKobo).toLocaleString()}. Contact support for larger payouts.`,
    );
  }
  if (amountKobo > availableKobo) {
    throw ApiError.conflict("Insufficient available balance for this withdrawal.");
  }
}

/** Postgres unique-violation code — used to turn double-clicks into safe no-ops. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/** transfer.failed / transfer.reversed must restore the vendor's balance. */
export function shouldReverseForEvent(event: string): boolean {
  return event === "transfer.failed" || event === "transfer.reversed";
}

/**
 * Pure webhook transition: given the stored status and the incoming event,
 * returns the next status, or null when the event must NOT change anything
 * (terminal state already reached → replayed delivery, or unknown event).
 */
export function nextWithdrawalStatus(current: string, event: string): WithdrawalStatus | null {
  if (isTerminalWithdrawalStatus(current)) return null;
  switch (event) {
    case "transfer.success":
      return "SUCCESS";
    case "transfer.failed":
      return "FAILED";
    case "transfer.reversed":
      return "REVERSED";
    case "transfer.pending":
      return current === "PENDING" ? "PROCESSING" : null;
    case "transfer.otp":
      return "OTP";
    default:
      return null;
  }
}

export function generateWithdrawalReference(): string {
  return `SV-WD-${randomBytes(8).toString("hex").toUpperCase()}`;
}

export function generateIdempotencyKey(): string {
  return randomUUID();
}

// ── DB-backed wallet operations ─────────────────────────────────────────────

export type Wallet = {
  vendor_id: string;
  available_kobo: string | number;
  pending_kobo: string | number;
};

export type WithdrawalRow = {
  id: string;
  vendor_id: string;
  amount_kobo: string | number;
  recipient_code: string;
  bank_code: string | null;
  account_number: string | null;
  account_name: string | null;
  reference: string;
  paystack_transfer_code: string | null;
  status: WithdrawalStatus;
  failure_reason: string | null;
  idempotency_key: string;
  approved_by: string | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toInt(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

async function getHoldDays(): Promise<number> {
  try {
    const config = (await getPayoutConfig()) as Record<string, unknown>;
    const raw = config["hold_days"] ?? config["holdDays"];
    return typeof raw === "number" && raw >= 0 ? raw : WITHDRAWAL_LIMITS.holdDays;
  } catch {
    return WITHDRAWAL_LIMITS.holdDays;
  }
}

/**
 * Credit a vendor's PENDING wallet when an order is DELIVERED. Idempotent:
 * the partial unique index on (order_id, CREDIT_HOLD) makes a second call a
 * no-op. Best-effort — callers must never fail delivery on ledger errors.
 */
export async function creditVendorForOrder(orderId: string): Promise<boolean> {
  const sql = db();
  const settlements = await sql<{
    vendor_id: string;
    vendor_net: string;
  }[]>`
    SELECT vendor_id, vendor_net::text AS vendor_net
    FROM order_settlements
    WHERE order_id = ${orderId} AND status = 'PAYABLE'
    LIMIT 1
  `;
  const settlement = settlements[0];
  if (!settlement) return false;
  const amountKobo = Math.round(Number(settlement.vendor_net) * 100);
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) return false;

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO vendor_wallets (vendor_id, available_kobo, pending_kobo)
        VALUES (${settlement.vendor_id}, 0, 0)
        ON CONFLICT (vendor_id) DO NOTHING
      `;
      const wallets = await tx<Wallet[]>`
        SELECT vendor_id, available_kobo, pending_kobo FROM vendor_wallets
        WHERE vendor_id = ${settlement.vendor_id} FOR UPDATE
      `;
      const wallet = wallets[0];
      if (!wallet) throw ApiError.internal();
      const pending = toInt(wallet.pending_kobo) + amountKobo;
      await tx`
        UPDATE vendor_wallets SET pending_kobo = ${pending}, updated_at = NOW()
        WHERE vendor_id = ${settlement.vendor_id}
      `;
      await tx`
        INSERT INTO vendor_wallet_entries
          (vendor_id, kind, amount_kobo, balance_after_kobo, order_id, meta)
        VALUES (
          ${settlement.vendor_id}, 'CREDIT_HOLD', ${amountKobo}, ${pending}, ${orderId},
          ${tx.json({ vendorNetNaira: Number(settlement.vendor_net) })}
        )
        ON CONFLICT DO NOTHING
      `;
    });
    return true;
  } catch (error) {
    // Unique-violation on the HOLD entry (or a concurrent credit race) means
    // the order was already credited — that is the safe outcome.
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Move matured holds (older than holdDays) into available balance.
 * Returns the released kobo. Safe to call on every read path.
 */
export async function releaseDueHolds(vendorId: string, holdDays?: number): Promise<number> {
  const sql = db();
  const days = holdDays ?? (await getHoldDays());
  const matured = await sql<{ order_id: string; vendor_net: string }[]>`
    SELECT s.order_id, s.vendor_net::text AS vendor_net
    FROM order_settlements s
    WHERE s.vendor_id = ${vendorId}
      AND s.status = 'PAYABLE'
      AND s.created_at < NOW() - make_interval(days => ${days})
      AND EXISTS (
        SELECT 1 FROM vendor_wallet_entries h
        WHERE h.order_id = s.order_id AND h.kind = 'CREDIT_HOLD'
      )
      AND NOT EXISTS (
        SELECT 1 FROM vendor_wallet_entries r
        WHERE r.order_id = s.order_id AND r.kind = 'HOLD_RELEASE'
      )
  `;
  if (matured.length === 0) return 0;

  let released = 0;
  await sql.begin(async (tx) => {
    const wallets = await tx<Wallet[]>`
      SELECT vendor_id, available_kobo, pending_kobo FROM vendor_wallets
      WHERE vendor_id = ${vendorId} FOR UPDATE
    `;
    let available = toInt(wallets[0]?.available_kobo);
    let pending = toInt(wallets[0]?.pending_kobo);
    for (const row of matured) {
      const amountKobo = Math.round(Number(row.vendor_net) * 100);
      if (!Number.isFinite(amountKobo) || amountKobo <= 0) continue;
      pending = Math.max(0, pending - amountKobo);
      available += amountKobo;
      released += amountKobo;
      await tx`
        INSERT INTO vendor_wallet_entries
          (vendor_id, kind, amount_kobo, balance_after_kobo, order_id, meta)
        VALUES (
          ${vendorId}, 'HOLD_RELEASE', ${amountKobo}, ${available}, ${row.order_id},
          ${tx.json({ releasedAfterDays: days })}
        )
        ON CONFLICT DO NOTHING
      `;
    }
    await tx`
      UPDATE vendor_wallets
      SET available_kobo = ${available}, pending_kobo = ${pending}, updated_at = NOW()
      WHERE vendor_id = ${vendorId}
    `;
  });
  return released;
}

export async function getWallet(vendorId: string): Promise<{ availableKobo: number; pendingKobo: number }> {
  await releaseDueHolds(vendorId).catch(() => undefined);
  const rows = await db()<Wallet[]>`
    SELECT vendor_id, available_kobo, pending_kobo FROM vendor_wallets
    WHERE vendor_id = ${vendorId} LIMIT 1
  `;
  return {
    availableKobo: toInt(rows[0]?.available_kobo),
    pendingKobo: toInt(rows[0]?.pending_kobo),
  };
}

export type RequestWithdrawalInput = {
  vendorId: string;
  amountKobo: number;
  recipientCode: string;
  bankCode?: string | null;
  accountNumber?: string | null;
  accountName?: string | null;
  idempotencyKey?: string | null;
};

/**
 * Deduct-then-call: in ONE transaction, lock the wallet, check the balance,
 * deduct, and create the withdrawal as PENDING with its server-side
 * reference. The Paystack call happens only AFTER commit (see transfers.ts).
 * A duplicate idempotency_key returns the existing row (double-click safe).
 */
export async function requestWithdrawal(input: RequestWithdrawalInput): Promise<{
  withdrawal: WithdrawalRow;
  duplicate: boolean;
}> {
  const sql = db();
  const idempotencyKey = input.idempotencyKey?.trim() || generateIdempotencyKey();

  // Fast path for retried submits: same key → same row, no second deduction.
  const existing = await sql<WithdrawalRow[]>`
    SELECT * FROM vendor_withdrawals WHERE idempotency_key = ${idempotencyKey} LIMIT 1
  `;
  if (existing[0]) {
    if (existing[0].vendor_id !== input.vendorId) {
      throw ApiError.forbidden("You do not have access to this withdrawal.");
    }
    return { withdrawal: existing[0], duplicate: true };
  }

  if (!Number.isInteger(input.amountKobo) || input.amountKobo <= 0) {
    throw ApiError.validation("Enter a valid withdrawal amount.");
  }
  if (!input.recipientCode.trim()) {
    throw ApiError.validation("Add and verify your bank account before withdrawing.");
  }

  const reference = generateWithdrawalReference();
  try {
    const withdrawal = await sql.begin(async (tx) => {
      await tx`
        INSERT INTO vendor_wallets (vendor_id, available_kobo, pending_kobo)
        VALUES (${input.vendorId}, 0, 0)
        ON CONFLICT (vendor_id) DO NOTHING
      `;
      const wallets = await tx<Wallet[]>`
        SELECT vendor_id, available_kobo, pending_kobo FROM vendor_wallets
        WHERE vendor_id = ${input.vendorId} FOR UPDATE
      `;
      const available = toInt(wallets[0]?.available_kobo);
      validateWithdrawalAmount(input.amountKobo, available);

      const nextAvailable = available - input.amountKobo;
      await tx`
        UPDATE vendor_wallets SET available_kobo = ${nextAvailable}, updated_at = NOW()
        WHERE vendor_id = ${input.vendorId}
      `;
      const entryRows = await tx<{ id: string }[]>`
        INSERT INTO vendor_wallet_entries
          (vendor_id, kind, amount_kobo, balance_after_kobo, meta)
        VALUES (
          ${input.vendorId}, 'WITHDRAW_LOCK', ${-input.amountKobo}, ${nextAvailable},
          ${tx.json({ reference, amountKobo: input.amountKobo })}
        )
        RETURNING id
      `;
      void entryRows;

      const rows = await tx<WithdrawalRow[]>`
        INSERT INTO vendor_withdrawals
          (vendor_id, amount_kobo, recipient_code, bank_code, account_number,
           account_name, reference, status, idempotency_key)
        VALUES (
          ${input.vendorId}, ${input.amountKobo}, ${input.recipientCode.trim()},
          ${input.bankCode ?? null}, ${input.accountNumber ?? null}, ${input.accountName ?? null},
          ${reference}, 'PENDING', ${idempotencyKey}
        )
        RETURNING *
      `;
      const created = rows[0];
      await tx`
        UPDATE vendor_wallet_entries SET withdrawal_id = ${created.id}
        WHERE vendor_id = ${input.vendorId} AND kind = 'WITHDRAW_LOCK'
          AND withdrawal_id IS NULL AND meta->>'reference' = ${reference}
      `;
      return created;
    });
    return { withdrawal, duplicate: false };
  } catch (error) {
    // Lost the commit race with an identical retry: return the winner's row.
    if (isUniqueViolation(error)) {
      const winner = await sql<WithdrawalRow[]>`
        SELECT * FROM vendor_withdrawals WHERE idempotency_key = ${idempotencyKey} LIMIT 1
      `;
      if (winner[0]) {
        if (winner[0].vendor_id !== input.vendorId) throw ApiError.forbidden("You do not have access to this withdrawal.");
        return { withdrawal: winner[0], duplicate: true };
      }
    }
    throw error;
  }
}

/** Mark a withdrawal after the synchronous initiate-transfer response. */
export async function markWithdrawalSubmitted(input: {
  withdrawalId: string;
  status: Extract<WithdrawalStatus, "PROCESSING" | "SUCCESS" | "OTP">;
  transferCode?: string | null;
  failureReason?: string | null;
}): Promise<void> {
  const sql = db();
  await sql`
    UPDATE vendor_withdrawals
    SET status = ${input.status},
        paystack_transfer_code = COALESCE(${input.transferCode ?? null}, paystack_transfer_code),
        failure_reason = ${input.failureReason ?? null},
        paid_at = CASE WHEN ${input.status} = 'SUCCESS' THEN NOW() ELSE paid_at END,
        updated_at = NOW()
    WHERE id = ${input.withdrawalId} AND status IN ('PENDING', 'PROCESSING', 'OTP')
  `;
}

/** Park an ambiguous withdrawal (timeout/5xx) as PROCESSING — resolved later
 *  via webhook or GET /transfer/verify. Never auto-refund: Paystack may have
 *  accepted the transfer despite the failed response. */
export async function markWithdrawalProcessing(withdrawalId: string, reason: string): Promise<void> {
  const sql = db();
  await sql`
    UPDATE vendor_withdrawals
    SET status = 'PROCESSING', failure_reason = ${reason}, updated_at = NOW()
    WHERE id = ${withdrawalId} AND status = 'PENDING'
  `;
}

/**
 * Idempotent webhook applier. The caller must first insert the event into
 * paystack_webhook_events (ON CONFLICT DO NOTHING) — if that insert finds an
 * existing key, skip this function entirely (replay). FAILED/REVERSED
 * transitions restore the vendor's available balance with a WITHDRAW_REVERSAL
 * ledger entry. Returns the post-transition row, or null for unknown events.
 */
export async function applyTransferWebhook(input: {
  event: string;
  reference: string;
  transferCode?: string | null;
  paystackStatus?: string | null;
  failureReason?: string | null;
}): Promise<WithdrawalRow | null> {
  const next = nextWithdrawalStatus(
    (await db()<WithdrawalRow[]>`SELECT * FROM vendor_withdrawals WHERE reference = ${input.reference} LIMIT 1`)[0]?.status ??
      "PENDING",
    input.event,
  );
  // Unknown event — caller still records the raw event row, but nothing changes.
  if (!next && !shouldReverseForEvent(input.event) && input.event !== "transfer.success") return null;

  const sql = db();
  return sql.begin(async (tx) => {
    const rows = await tx<WithdrawalRow[]>`
      SELECT * FROM vendor_withdrawals WHERE reference = ${input.reference} FOR UPDATE
    `;
    const withdrawal = rows[0];
    if (!withdrawal) return null;
    const target = nextWithdrawalStatus(withdrawal.status, input.event);
    if (!target) return withdrawal;

    const reversal = shouldReverseForEvent(input.event) && withdrawal.status !== target;
    await tx`
      UPDATE vendor_withdrawals
      SET status = ${target},
          paystack_transfer_code = COALESCE(${input.transferCode ?? null}, paystack_transfer_code),
          failure_reason = ${input.failureReason ?? (reversal ? input.event : null)},
          paid_at = CASE WHEN ${target} = 'SUCCESS' THEN NOW() ELSE paid_at END,
          updated_at = NOW()
      WHERE id = ${withdrawal.id}
    `;

    if (reversal) {
      const wallets = await tx<Wallet[]>`
        SELECT vendor_id, available_kobo, pending_kobo FROM vendor_wallets
        WHERE vendor_id = ${withdrawal.vendor_id} FOR UPDATE
      `;
      const available = toInt(wallets[0]?.available_kobo) + toInt(withdrawal.amount_kobo);
      await tx`
        UPDATE vendor_wallets SET available_kobo = ${available}, updated_at = NOW()
        WHERE vendor_id = ${withdrawal.vendor_id}
      `;
      await tx`
        INSERT INTO vendor_wallet_entries
          (vendor_id, kind, amount_kobo, balance_after_kobo, withdrawal_id, meta)
        VALUES (
          ${withdrawal.vendor_id}, 'WITHDRAW_REVERSAL', ${toInt(withdrawal.amount_kobo)},
          ${available}, ${withdrawal.id},
          ${tx.json({ event: input.event, reference: input.reference })}
        )
      `;
    }

    const updated = await tx<WithdrawalRow[]>`SELECT * FROM vendor_withdrawals WHERE id = ${withdrawal.id} LIMIT 1`;
    return updated[0] ?? null;
  });
}

/** Fail a withdrawal and restore funds (validation/4xx rejections only —
 *  never for ambiguous outcomes). Used when Paystack rejects pre-submission. */
export async function failWithdrawalAndReverse(withdrawalId: string, reason: string): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    const rows = await tx<WithdrawalRow[]>`SELECT * FROM vendor_withdrawals WHERE id = ${withdrawalId} FOR UPDATE`;
    const withdrawal = rows[0];
    if (!withdrawal || isTerminalWithdrawalStatus(withdrawal.status)) return;
    await tx`
      UPDATE vendor_withdrawals
      SET status = 'FAILED', failure_reason = ${reason}, updated_at = NOW()
      WHERE id = ${withdrawalId}
    `;
    const wallets = await tx<Wallet[]>`
      SELECT vendor_id, available_kobo, pending_kobo FROM vendor_wallets
      WHERE vendor_id = ${withdrawal.vendor_id} FOR UPDATE
    `;
    const available = toInt(wallets[0]?.available_kobo) + toInt(withdrawal.amount_kobo);
    await tx`
      UPDATE vendor_wallets SET available_kobo = ${available}, updated_at = NOW()
      WHERE vendor_id = ${withdrawal.vendor_id}
    `;
    await tx`
      INSERT INTO vendor_wallet_entries
        (vendor_id, kind, amount_kobo, balance_after_kobo, withdrawal_id, meta)
      VALUES (
        ${withdrawal.vendor_id}, 'WITHDRAW_REVERSAL', ${toInt(withdrawal.amount_kobo)},
        ${available}, ${withdrawalId}, ${tx.json({ reason })}
      )
    `;
  });
}
