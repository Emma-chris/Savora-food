import { NextResponse, type NextRequest } from "next/server";
import { ok, toEnvelope } from "@/server/errors";
import { requireAdminUser } from "@/server/admin";
import { db } from "@/server/db";
import { koboToNaira, type WithdrawalRow } from "@/server/wallet";

/** Finance view of vendor-initiated withdrawals (new Paystack-rail flow). */
export async function GET(request: NextRequest) {
  try {
    await requireAdminUser(request);
    const url = new URL(request.url);
    const status = url.searchParams.get("status")?.trim() || "";
    const where = status
      ? db()`w.status = ${status}`
      : db()`TRUE`;
    const rows = await db()<{
      id: string;
      vendor_id: string;
      vendor_name: string;
      amount_kobo: string;
      reference: string;
      paystack_transfer_code: string | null;
      status: string;
      failure_reason: string | null;
      account_number: string | null;
      account_name: string | null;
      created_at: Date;
    }[]>`
      SELECT w.id, w.vendor_id, v.business_name AS vendor_name, w.amount_kobo::text,
             w.reference, w.paystack_transfer_code, w.status, w.failure_reason,
             w.account_number, w.account_name, w.created_at
      FROM vendor_withdrawals w
      JOIN vendors v ON v.id = w.vendor_id
      WHERE ${where}
      ORDER BY w.created_at DESC
      LIMIT 50
    `;
    return NextResponse.json(
      ok(
        rows.map((row) => ({
          id: row.id,
          vendorId: row.vendor_id,
          vendorName: row.vendor_name,
          amountKobo: Number(row.amount_kobo),
          amount: koboToNaira(Number(row.amount_kobo)),
          reference: row.reference,
          transferCode: row.paystack_transfer_code,
          status: row.status,
          failureReason: row.failure_reason,
          accountNumber: row.account_number,
          accountName: row.account_name,
          createdAt: row.created_at,
        })),
        { count: rows.length },
      ),
    );
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}

export type { WithdrawalRow };
