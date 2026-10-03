import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, toEnvelope } from "@/server/errors";
import { requireVendor } from "@/server/auth/guard";
import { getVendorContext } from "@/server/vendors";
import { db } from "@/server/db";
import { createTransferRecipient, resolveAccount } from "@/server/payments/transfers";

const saveSchema = z.object({
  accountNumber: z.string().trim().regex(/^\d{10}$/, "Enter a valid 10-digit account number."),
  bankCode: z.string().trim().min(1, "Select a bank.").max(20),
});

/** Returns the vendor's saved transfer recipient (if any). */
export async function GET(request: NextRequest) {
  try {
    const session = await requireVendor(request);
    const vendor = await getVendorContext(session.id);
    const rows = await db()<{
      recipient_code: string | null;
      bank_code: string | null;
      bank_name: string | null;
      bank_account_name: string | null;
      bank_account_number: string | null;
    }[]>`
      SELECT recipient_code, bank_code, bank_name, bank_account_name, bank_account_number
      FROM vendors WHERE id = ${vendor.id} LIMIT 1
    `;
    const row = rows[0];
    return NextResponse.json(
      ok({
        recipientCode: row?.recipient_code ?? null,
        bankCode: row?.bank_code ?? null,
        bankName: row?.bank_name ?? null,
        accountName: row?.bank_account_name ?? null,
        accountNumber: row?.bank_account_number ?? null,
        verified: Boolean(row?.recipient_code),
      }),
    );
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}

/**
 * Verify + save the vendor's payout account. Flow: resolve the account
 * (proves it exists and returns the real account name — never trust the
 * client-typed name), create the Paystack transfer recipient, store the
 * recipient_code on the vendor. Reuses the stored code when nothing changed.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireVendor(request);
    const vendor = await getVendorContext(session.id);
    const parsed = saveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiError.validation("Please fix the errors in your submission.", parsed.error.flatten().fieldErrors);
    }

    const sql = db();
    const current = await sql<{
      recipient_code: string | null;
      bank_account_number: string | null;
      bank_code: string | null;
    }[]>`
      SELECT recipient_code, bank_account_number, bank_code FROM vendors
      WHERE id = ${vendor.id} LIMIT 1
    `;
    if (
      current[0]?.recipient_code &&
      current[0]?.bank_account_number === parsed.data.accountNumber &&
      current[0]?.bank_code === parsed.data.bankCode
    ) {
      return NextResponse.json(ok({ recipientCode: current[0].recipient_code, reused: true }));
    }

    // Step 1: prove the account exists and learn the real account holder name.
    const resolved = await resolveAccount({
      accountNumber: parsed.data.accountNumber,
      bankCode: parsed.data.bankCode,
    });

    // Step 2: create the Paystack recipient under the verified name.
    const recipient = await createTransferRecipient({
      accountNumber: resolved.accountNumber,
      bankCode: parsed.data.bankCode,
      name: resolved.accountName,
    });
    if (!recipient.recipientCode) {
      throw ApiError.paymentError("Could not create the transfer recipient. Try again.");
    }

    await sql`
      UPDATE vendors
      SET recipient_code = ${recipient.recipientCode},
          bank_code = ${parsed.data.bankCode},
          bank_account_number = ${resolved.accountNumber},
          bank_account_name = ${resolved.accountName},
          updated_at = NOW()
      WHERE id = ${vendor.id}
    `;

    return NextResponse.json(
      ok({
        recipientCode: recipient.recipientCode,
        accountName: resolved.accountName,
        accountNumber: resolved.accountNumber,
        reused: false,
      }),
      { status: 201 },
    );
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}
