import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, toEnvelope } from "@/server/errors";
import { auditLog, requireAdminUser } from "@/server/admin";
import { db } from "@/server/db";
import {
  failWithdrawalAndReverse,
  markWithdrawalProcessing,
  markWithdrawalSubmitted,
  type WithdrawalRow,
} from "@/server/wallet";
import { PaystackTransferError, initiateTransfer } from "@/server/payments/transfers";

const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional().nullable(),
});

/**
 * Approve (executes the Paystack transfer for a PENDING large withdrawal) or
 * reject (restores the locked funds to the vendor's available balance).
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminUser(request);
    const { id } = await ctx.params;
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiError.validation("Please fix the errors in your submission.", parsed.error.flatten().fieldErrors);
    }

    const sql = db();
    const rows = await sql<WithdrawalRow[]>`SELECT * FROM vendor_withdrawals WHERE id = ${id} LIMIT 1`;
    const withdrawal = rows[0];
    if (!withdrawal) throw ApiError.notFound("Withdrawal not found.");
    if (withdrawal.status !== "PENDING") {
      throw ApiError.conflict(`Only pending withdrawals can be reviewed (current: ${withdrawal.status}).`);
    }

    if (parsed.data.action === "reject") {
      await failWithdrawalAndReverse(id, parsed.data.note ?? "Rejected by finance.");
      await auditLog({
        userId: admin.id,
        action: "withdrawal.reject",
        entityType: "withdrawal",
        entityId: id,
        meta: { vendorId: withdrawal.vendor_id, amountKobo: Number(withdrawal.amount_kobo) },
      });
      return NextResponse.json(ok({ status: "FAILED", reversed: true }));
    }

    // Approve: same deduct-after-commit guarantee already holds (funds were
    // locked at request time), so execute the transfer now.
    try {
      const result = await initiateTransfer({
        amountKobo: Number(withdrawal.amount_kobo),
        recipientCode: withdrawal.recipient_code,
        reference: withdrawal.reference,
      });
      if (result.requiresOtp) {
        await markWithdrawalSubmitted({
          withdrawalId: id,
          status: "OTP",
          transferCode: result.transferCode,
          failureReason: "Paystack requires OTP confirmation. Approve the transfer in the Paystack dashboard.",
        });
      } else if (result.status === "success") {
        await markWithdrawalSubmitted({ withdrawalId: id, status: "SUCCESS", transferCode: result.transferCode });
      } else {
        await markWithdrawalSubmitted({ withdrawalId: id, status: "PROCESSING", transferCode: result.transferCode });
      }
    } catch (error) {
      if (error instanceof PaystackTransferError) {
        if (error.ambiguous) {
          await markWithdrawalProcessing(id, error.paystackMessage).catch(() => undefined);
        } else {
          await failWithdrawalAndReverse(id, error.paystackMessage).catch(() => undefined);
        }
        throw error;
      }
      await markWithdrawalProcessing(id, "Transfer initiation failed.").catch(() => undefined);
      throw error;
    }

    await sql`
      UPDATE vendor_withdrawals SET approved_by = ${admin.id}, updated_at = NOW() WHERE id = ${id}
    `;
    await auditLog({
      userId: admin.id,
      action: "withdrawal.approve",
      entityType: "withdrawal",
      entityId: id,
      meta: { vendorId: withdrawal.vendor_id, amountKobo: Number(withdrawal.amount_kobo) },
    });

    const updated = await sql<WithdrawalRow[]>`SELECT * FROM vendor_withdrawals WHERE id = ${id} LIMIT 1`;
    return NextResponse.json(ok({ status: updated[0]?.status ?? "PROCESSING" }));
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}
