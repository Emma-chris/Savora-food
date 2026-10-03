import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, toEnvelope } from "@/server/errors";
import { requireVendor } from "@/server/auth/guard";
import { getVendorContext } from "@/server/vendors";
import { db } from "@/server/db";
import {
  WITHDRAWAL_LIMITS,
  failWithdrawalAndReverse,
  getWallet,
  koboToNaira,
  markWithdrawalProcessing,
  markWithdrawalSubmitted,
  requestWithdrawal,
  type WithdrawalRow,
} from "@/server/wallet";
import {
  PaystackTransferError,
  initiateTransfer,
} from "@/server/payments/transfers";

const bodySchema = z.object({
  // Integer kobo from the client; re-validated server-side against the wallet.
  amountKobo: z.number().int().positive().max(WITHDRAWAL_LIMITS.maxWithdrawalKobo),
  // Client-generated UUID per submit; dedupes double-clicks. Server falls back
  // to generating one when absent.
  idempotencyKey: z.string().trim().max(100).optional().nullable(),
});

function toResponse(row: WithdrawalRow) {
  return {
    id: row.id,
    amountKobo: Number(row.amount_kobo),
    amount: koboToNaira(Number(row.amount_kobo)),
    reference: row.reference,
    transferCode: row.paystack_transfer_code,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

/** Withdrawal history + current wallet for the authenticated vendor. */
export async function GET(request: NextRequest) {
  try {
    const session = await requireVendor(request);
    const vendor = await getVendorContext(session.id);
    const wallet = await getWallet(vendor.id);
    const rows = await db()<WithdrawalRow[]>`
      SELECT * FROM vendor_withdrawals
      WHERE vendor_id = ${vendor.id}
      ORDER BY created_at DESC
      LIMIT 20
    `;
    return NextResponse.json(
      ok({
        availableKobo: wallet.availableKobo,
        available: koboToNaira(wallet.availableKobo),
        pendingKobo: wallet.pendingKobo,
        pending: koboToNaira(wallet.pendingKobo),
        limits: {
          minKobo: WITHDRAWAL_LIMITS.minWithdrawalKobo,
          min: koboToNaira(WITHDRAWAL_LIMITS.minWithdrawalKobo),
          maxKobo: WITHDRAWAL_LIMITS.maxWithdrawalKobo,
          max: koboToNaira(WITHDRAWAL_LIMITS.maxWithdrawalKobo),
          autoApproveBelowKobo: WITHDRAWAL_LIMITS.autoApproveBelowKobo,
          autoApproveBelow: koboToNaira(WITHDRAWAL_LIMITS.autoApproveBelowKobo),
        },
        withdrawals: rows.map(toResponse),
      }),
    );
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}

/**
 * Vendor withdrawal request. Never trusts the client for vendor ID (session
 * only) or balance (re-checked inside the locked transaction).
 *
 * Flow: deduct + create PENDING in ONE transaction → commit → call Paystack.
 * Above the auto-approve threshold the row stays PENDING for admin approval
 * and no Paystack call is made yet.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireVendor(request);
    const vendor = await getVendorContext(session.id);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiError.validation("Please fix the errors in your submission.", parsed.error.flatten().fieldErrors);
    }

    const vendorRows = await db()<{
      recipient_code: string | null;
      bank_code: string | null;
      bank_account_number: string | null;
      bank_account_name: string | null;
    }[]>`
      SELECT recipient_code, bank_code, bank_account_number, bank_account_name
      FROM vendors WHERE id = ${vendor.id} LIMIT 1
    `;
    const recipientCode = vendorRows[0]?.recipient_code;
    if (!recipientCode) {
      throw ApiError.validation("Add and verify your bank account before withdrawing.");
    }

    const { withdrawal, duplicate } = await requestWithdrawal({
      vendorId: vendor.id,
      amountKobo: parsed.data.amountKobo,
      recipientCode,
      bankCode: vendorRows[0]?.bank_code,
      accountNumber: vendorRows[0]?.bank_account_number,
      accountName: vendorRows[0]?.bank_account_name,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (duplicate) {
      return NextResponse.json(ok({ ...toResponse(withdrawal), duplicate: true }));
    }

    // Large withdrawals park for finance approval — no Paystack call yet.
    if (parsed.data.amountKobo > WITHDRAWAL_LIMITS.autoApproveBelowKobo) {
      return NextResponse.json(
        ok({
          ...toResponse(withdrawal),
          message: "Withdrawal submitted and awaiting finance approval.",
        }),
        { status: 201 },
      );
    }

    // Auto-approved: initiate the transfer AFTER the deduction committed.
    try {
      const result = await initiateTransfer({
        amountKobo: Number(withdrawal.amount_kobo),
        recipientCode: withdrawal.recipient_code,
        reference: withdrawal.reference,
      });
      if (result.requiresOtp) {
        // OTP confirmation is enabled on the Paystack account: someone must
        // approve in the dashboard. Funds stay locked until the webhook lands.
        await markWithdrawalSubmitted({
          withdrawalId: withdrawal.id,
          status: "OTP",
          transferCode: result.transferCode,
          failureReason: "Paystack requires OTP confirmation. Approve the transfer in the Paystack dashboard.",
        });
      } else if (result.status === "success") {
        await markWithdrawalSubmitted({
          withdrawalId: withdrawal.id,
          status: "SUCCESS",
          transferCode: result.transferCode,
        });
      } else {
        await markWithdrawalSubmitted({
          withdrawalId: withdrawal.id,
          status: "PROCESSING",
          transferCode: result.transferCode,
        });
      }
    } catch (error) {
      if (error instanceof PaystackTransferError) {
        if (error.ambiguous) {
          // Timeout/5xx/network: Paystack may still have accepted it. Park as
          // PROCESSING and let the webhook (or verify) decide the outcome.
          await markWithdrawalProcessing(withdrawal.id, error.paystackMessage).catch(() => undefined);
        } else {
          // Definitive rejection (validation, insufficient platform float):
          // restore the vendor's balance immediately.
          await failWithdrawalAndReverse(withdrawal.id, error.paystackMessage).catch(() => undefined);
        }
        throw error;
      }
      await markWithdrawalProcessing(withdrawal.id, "Transfer initiation failed.").catch(() => undefined);
      throw error;
    }

    const updated = await db()<WithdrawalRow[]>`SELECT * FROM vendor_withdrawals WHERE id = ${withdrawal.id} LIMIT 1`;
    return NextResponse.json(ok(toResponse(updated[0] ?? withdrawal)), { status: 201 });
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}
