"use client";

import { useRef, useState } from "react";
import { VendorShell, VendorSignIn, naira } from "@/components/VendorShell";
import {
  useRequestVendorWithdrawal,
  useSaveVendorRecipient,
  useVendorBanks,
  useVendorEarnings,
  useVendorProfile,
  useVendorRecipient,
  useVendorWithdrawals,
} from "@/lib/api/hooks";
import { resolveVendorBankAccount } from "@/lib/savora-api";

function withdrawalBadge(status: string): string {
  if (status === "SUCCESS") return "badge-success";
  if (status === "FAILED" || status === "REVERSED") return "badge-danger";
  return "badge-warning";
}

export default function VendorPayoutsPage() {
  const profile = useVendorProfile();
  const earnings = useVendorEarnings();
  const withdrawals = useVendorWithdrawals();
  const recipient = useVendorRecipient();
  const banks = useVendorBanks();
  const saveRecipient = useSaveVendorRecipient();
  const requestWithdrawal = useRequestVendorWithdrawal();

  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amountNaira, setAmountNaira] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);

  // One UUID per submit attempt, created in the click handler (not render).
  // A double-click reuses the same key, so the server treats the second POST
  // as a duplicate instead of a new debit. Reset after each attempt.
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

  if (profile.isLoading) {
    return (
      <main className="page-shell">
        <section className="section container">
          <p className="muted">Loading…</p>
        </section>
      </main>
    );
  }
  if (profile.isError || !profile.data) return <VendorSignIn />;

  const wallet = withdrawals.data;
  const availableKobo = wallet?.availableKobo ?? earnings.data?.wallet?.availableKobo ?? 0;
  const pendingKobo = wallet?.pendingKobo ?? earnings.data?.wallet?.pendingKobo ?? 0;

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
      const result = await resolveVendorBankAccount({ account_number: accountNumber, bank_code: bankCode });
      setResolvedName(result.accountName);
    } catch (error) {
      setResolveError(error instanceof Error ? error.message : "Could not verify this account.");
    } finally {
      setResolving(false);
    }
  }

  async function handleSaveRecipient() {
    setFormError(null);
    setFormNote(null);
    try {
      const result = await saveRecipient.mutateAsync({ accountNumber, bankCode });
      setResolvedName(result.accountName ?? resolvedName);
      setFormNote(
        result.reused ? "Bank account already saved." : `Bank account verified${result.accountName ? ` (${result.accountName})` : ""} and saved.`,
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save bank account.");
    }
  }

  async function handleWithdraw() {
    setFormError(null);
    setFormNote(null);
    const naira = Number(amountNaira);
    if (!Number.isFinite(naira) || naira <= 0) {
      setFormError("Enter a valid amount in naira.");
      return;
    }
    const amountKobo = Math.round(naira * 100);
    const idempotencyKey = nextIdempotencyKey();
    try {
      const result = await requestWithdrawal.mutateAsync({ amountKobo, idempotencyKey });
      if (result.status === "PENDING") {
        setFormNote(`Withdrawal ${result.reference} submitted — awaiting finance approval.`);
      } else if (result.status === "OTP") {
        setFormNote(`Withdrawal ${result.reference} needs OTP approval in the Paystack dashboard.`);
      } else if (result.status === "PROCESSING") {
        setFormNote(`Withdrawal ${result.reference} is processing. Status updates automatically.`);
      } else if (result.status === "SUCCESS") {
        setFormNote(`Withdrawal ${result.reference} completed.`);
      } else {
        setFormNote(`Withdrawal ${result.reference}: ${result.status}${result.failureReason ? ` — ${result.failureReason}` : ""}`);
      }
      setAmountNaira("");
      idempotencyRef.current = null;
    } catch (error) {
      // Keep the key on failure: an immediate retry then hits the server's
      // duplicate path (returns the existing PROCESSING row) instead of
      // creating a second deduction.
      setFormError(error instanceof Error ? error.message : "Withdrawal failed.");
    }
  }

  return (
    <VendorShell
      profile={profile.data}
      title="Earnings & payouts"
      sub={`Platform commission: ${earnings.data?.commissionRate ?? "—"}% of settled orders.`}
    >
      {earnings.isLoading ? (
        <p className="muted">Loading earnings…</p>
      ) : earnings.data ? (
        <>
          <div className="hero-stats">
            <div className="stat">
              <b>{naira(earnings.data.wallet ? earnings.data.wallet.available : earnings.data.availableBalance)}</b>
              <span>Available balance</span>
            </div>
            <div className="stat">
              <b>{naira(earnings.data.wallet?.pending ?? 0)}</b>
              <span>Pending (hold period)</span>
            </div>
            <div className="stat">
              <b>{naira(earnings.data.last30Days.net)}</b>
              <span>Net · last 30 days ({earnings.data.last30Days.orders} orders)</span>
            </div>
            <div className="stat">
              <b>{naira(earnings.data.paidOut)}</b>
              <span>Total paid out</span>
            </div>
          </div>

          <h2 style={{ marginTop: 32 }}>Withdraw to bank</h2>
          <div className="card card-body" style={{ display: "grid", gap: 12, maxWidth: 560 }}>
            <p className="muted" style={{ margin: 0 }}>
              Available: <strong>{naira(availableKobo / 100)}</strong>
              {pendingKobo > 0 ? ` · ${naira(pendingKobo / 100)} still in hold` : ""}
              {wallet ? ` · Min ${naira(wallet.limits.min)} · Max ${naira(wallet.limits.max)}` : ""}
            </p>
            {recipient.data?.verified ? (
              <p className="muted" style={{ margin: 0 }}>
                Saved account: <strong>{recipient.data.accountName}</strong> · {recipient.data.accountNumber}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Verify your bank account below before withdrawing.</p>
            )}

            <label>
              Bank
              <select value={bankCode} onChange={(event) => setBankCode(event.target.value)}>
                <option value="">Select bank…</option>
                {(banks.data ?? []).map((bank) => (
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
                onClick={handleSaveRecipient}
                disabled={saveRecipient.isPending || !resolvedName}
                title={resolvedName ? "Save verified account" : "Verify the account first"}
              >
                {saveRecipient.isPending ? "Saving…" : "Save account"}
              </button>
            </div>
            {resolvedName ? <p className="auth-success">Account name: {resolvedName}</p> : null}
            {resolveError ? <p className="auth-error">{resolveError}</p> : null}

            <label>
              Amount (₦)
              <input
                value={amountNaira}
                inputMode="decimal"
                placeholder="e.g. 5000"
                onChange={(event) => setAmountNaira(event.target.value)}
              />
            </label>
            <button className="btn" type="button" onClick={handleWithdraw} disabled={requestWithdrawal.isPending}>
              {requestWithdrawal.isPending ? "Submitting…" : "Request withdrawal"}
            </button>
            {formError ? <p className="auth-error">{formError}</p> : null}
            {formNote ? <p className="auth-success">{formNote}</p> : null}
            <p className="muted" style={{ margin: 0 }}>
              Withdrawals under {wallet ? naira(wallet.limits.autoApproveBelow) : "the threshold"} are sent automatically;
              larger ones need finance approval. Earnings unlock after a 48-hour hold.
            </p>
          </div>

          <h2 style={{ marginTop: 32 }}>Withdrawal history</h2>
          {(wallet?.withdrawals ?? []).length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-title">No withdrawals yet</p>
              <p className="empty-state-desc">
                Settled earnings unlock after the hold period, then you can withdraw them here.
              </p>
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
              {(wallet?.withdrawals ?? []).map((w) => (
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

          <h2 style={{ marginTop: 32 }}>Payout history</h2>
          {earnings.data.payouts.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-title">No payouts yet</p>
              <p className="empty-state-desc">
                Settled earnings accumulate in your available balance. Payouts are processed by the Savora Food finance
                team.
              </p>
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
              {earnings.data.payouts.map((payout) => (
                <div className="card card-body" key={payout.id}>
                  <div className="row">
                    <div>
                      <strong>{payout.reference}</strong>
                      <p className="muted" style={{ margin: "4px 0 0" }}>
                        {[payout.periodStart, payout.periodEnd].filter(Boolean).join(" → ") || "Ad-hoc"} · Gross{" "}
                        {naira(payout.gross)} · Commission {naira(payout.commission)}
                      </p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ margin: "0 0 6px" }}>
                        <strong className="price">{naira(payout.net)}</strong>
                      </p>
                      <span
                        className={`badge ${payout.status === "PAID" ? "badge-success" : payout.status === "FAILED" ? "badge-danger" : "badge-warning"}`}
                      >
                        {payout.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="auth-error">Could not load earnings.</p>
      )}
    </VendorShell>
  );
}
