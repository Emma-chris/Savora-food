"use client";

import { useRef, useState } from "react";
import type { PayoutOverview, PayoutRecipient, PayoutWithdrawal, PaystackBankOption } from "@/lib/savora-api";

/**
 * Shared payout panel — one implementation for vendors AND riders.
 *
 * All money handling lives here: naira → kobo conversion, the per-submit
 * idempotency key (so a double-click cannot debit twice), and the withdrawal
 * status copy. Owner-specific data/hooks are injected by the page, so neither
 * rail gets a private copy of this logic.
 */
export type PayoutPanelProps = {
  ownerType: "VENDOR" | "RIDER";
  overview?: PayoutOverview | null;
  account?: PayoutRecipient | null;
  banks?: PaystackBankOption[] | null;
  /** Used when the overview query has not resolved yet. */
  availableKobo: number;
  pendingKobo: number;
  /** "vendor" / "rider" — used in copy only. */
  subject: string;
  saving: boolean;
  withdrawing: boolean;
  onResolveAccount: (input: { accountNumber: string; bankCode: string }) => Promise<{ accountName: string }>;
  onSaveAccount: (input: {
    accountNumber: string;
    bankCode: string;
  }) => Promise<{ accountName?: string; reused?: boolean }>;
  onWithdraw: (input: { amountKobo: number; idempotencyKey: string }) => Promise<PayoutWithdrawal>;
};

function naira(value: number): string {
  return `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function withdrawalBadge(status: string): string {
  if (status === "SUCCESS") return "badge-success";
  if (status === "FAILED" || status === "REVERSED") return "badge-danger";
  return "badge-warning";
}

function describeStatus(result: PayoutWithdrawal): string {
  const prefix = `Withdrawal ${result.reference}`;
  switch (result.status) {
    case "PENDING":
      return `${prefix} submitted — awaiting finance approval.`;
    case "OTP":
      return `${prefix} needs OTP approval in the Paystack dashboard.`;
    case "PROCESSING":
      return `${prefix} is processing. Status updates automatically.`;
    case "SUCCESS":
      return `${prefix} completed.`;
    default:
      return `${prefix}: ${result.status}${result.failureReason ? ` — ${result.failureReason}` : ""}`;
  }
}

export default function PayoutPanel(props: PayoutPanelProps) {
  const { account, banks, overview, subject } = props;
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);

  // One key per submit attempt, minted in the click handler (not render), so a
  // double-click reuses it and the server treats the 2nd POST as a duplicate.
  const idempotencyRef = useRef<string | null>(null);
  function nextIdempotencyKey(): string {
    if (!idempotencyRef.current) {
      idempotencyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return idempotencyRef.current;
  }

  async function handleResolve() {
    setResolveError(null);
    setResolvedName(null);
    if (!/^\d{10}$/.test(accountNumber)) {
      setResolveError("Enter a valid 10-digit account number.");
      return;
    }
    if (!bankCode) {
      setResolveError("Select a bank first.");
      return;
    }
    setResolving(true);
    try {
      const result = await props.onResolveAccount({ accountNumber, bankCode });
      setResolvedName(result.accountName);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "Could not verify this account.");
    } finally {
      setResolving(false);
    }
  }

  async function handleSave() {
    setFormError(null);
    setFormNote(null);
    try {
      const result = await props.onSaveAccount({ accountNumber, bankCode });
      setResolvedName(result.accountName ?? resolvedName);
      setFormNote(
        result.reused
          ? "Bank account already saved."
          : `Bank account verified${result.accountName ? ` (${result.accountName})` : ""} and saved.`,
      );
      idempotencyRef.current = null;
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save bank account.");
    }
  }

  async function handleWithdraw() {
    setFormError(null);
    setFormNote(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setFormError("Enter a valid amount in naira.");
      return;
    }
    try {
      const result = await props.onWithdraw({
        amountKobo: Math.round(value * 100),
        idempotencyKey: nextIdempotencyKey(),
      });
      setFormNote(describeStatus(result));
      setAmount("");
      idempotencyRef.current = null;
    } catch (error) {
      // Keep the key on failure: an immediate retry hits the server's duplicate
      // path (existing row returned) instead of a second deduction.
      setFormError(error instanceof Error ? error.message : "Withdrawal failed.");
    }
  }

  const holdDays = overview?.limits.holdDays ?? 0;

  return (
    <>
      <h2 style={{ marginTop: 32 }}>Withdraw to bank</h2>
      <div className="card card-body" style={{ display: "grid", gap: 12, maxWidth: 560 }}>
        <p className="muted" style={{ margin: 0 }}>
          Available: <strong>{naira(props.availableKobo / 100)}</strong>
          {props.pendingKobo > 0 ? ` · ${naira(props.pendingKobo / 100)} still in hold` : ""}
          {overview ? ` · Min ${naira(overview.limits.min)} · Max ${naira(overview.limits.max)}` : ""}
        </p>
        {account?.verified ? (
          <p className="muted" style={{ margin: 0 }}>
            Saved account: <strong>{account.accountName}</strong> · {account.accountNumber}
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Verify your bank account below before withdrawing.
          </p>
        )}
        {account?.coolingActive ? (
          <p className="auth-error" style={{ margin: 0 }}>
            For your protection, withdrawals are paused for {account.coolingHours}h after a bank account change
            {account.coolingEndsAt ? ` — available again ${new Date(account.coolingEndsAt).toLocaleString()}` : ""}.
          </p>
        ) : null}

        <label>
          Bank
          <select value={bankCode} onChange={(event) => setBankCode(event.target.value)}>
            <option value="">Select bank…</option>
            {(banks ?? []).map((bank) => (
              <option key={bank.code} value={bank.code}>
                {bank.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Account number
          <input
            value={accountNumber}
            inputMode="numeric"
            maxLength={10}
            placeholder="10-digit account number"
            onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))}
          />
        </label>
        <div className="row">
          <button className="btn btn-secondary" type="button" onClick={handleResolve} disabled={resolving}>
            {resolving ? "Verifying…" : "Verify account"}
          </button>
          <button
            className="btn"
            type="button"
            onClick={handleSave}
            disabled={props.saving || !resolvedName}
            title={resolvedName ? "Save verified account" : "Verify the account first"}
          >
            {props.saving ? "Saving…" : "Save account"}
          </button>
        </div>
        {resolvedName ? <p className="auth-success">Account name: {resolvedName}</p> : null}
        {resolveError ? <p className="auth-error">{resolveError}</p> : null}

        <label>
          Amount (₦)
          <input
            value={amount}
            inputMode="decimal"
            placeholder="e.g. 5000"
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <button
          className="btn"
          type="button"
          onClick={handleWithdraw}
          disabled={props.withdrawing || account?.coolingActive === true}
        >
          {props.withdrawing ? "Submitting…" : "Request withdrawal"}
        </button>
        {formError ? <p className="auth-error">{formError}</p> : null}
        {formNote ? <p className="auth-success">{formNote}</p> : null}
        <p className="muted" style={{ margin: 0 }}>
          Withdrawals under {overview ? naira(overview.limits.autoApproveBelow) : "the threshold"} are sent
          automatically; larger ones need finance approval.
          {holdDays > 0 ? ` ${subject === "rider" ? "Delivery fees" : "Earnings"} unlock after a ${holdDays}-day hold.` : ""}
        </p>
      </div>

      <h2 style={{ marginTop: 32 }}>Withdrawal history</h2>
      {(overview?.withdrawals ?? []).length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No withdrawals yet</p>
          <p className="empty-state-desc">
            {subject === "rider" ? "Delivery fees" : "Settled earnings"} unlock after the hold period, then you can
            withdraw them here.
          </p>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
          {(overview?.withdrawals ?? []).map((w) => (
            <div className="card card-body" key={w.id}>
              <div className="row">
                <div>
                  <strong>{w.reference}</strong>
                  <p className="muted" style={{ margin: "4px 0 0" }}>
                    {new Date(w.createdAt).toLocaleString()}
                    {w.failureReason ? ` · ${w.failureReason}` : ""}
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ margin: "0 0 6px" }}>
                    <strong className="price">{naira(w.amount)}</strong>
                  </p>
                  <span className={`badge ${withdrawalBadge(w.status)}`}>{w.status}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}