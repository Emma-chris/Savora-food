import { NextResponse, type NextRequest } from "next/server";
import { ApiError, ok, toEnvelope } from "@/server/errors";
import { requireVendor } from "@/server/auth/guard";
import { resolveAccount } from "@/server/payments/transfers";

/** Verify that an account number belongs to someone at the given bank. Read-only. */
export async function GET(request: NextRequest) {
  try {
    await requireVendor(request);
    const url = new URL(request.url);
    const accountNumber = url.searchParams.get("account_number")?.trim() ?? "";
    const bankCode = url.searchParams.get("bank_code")?.trim() ?? "";
    if (!/^\d{10}$/.test(accountNumber)) {
      throw ApiError.validation("Enter a valid 10-digit account number.");
    }
    if (!bankCode) {
      throw ApiError.validation("Select a bank.");
    }
    const result = await resolveAccount({ accountNumber, bankCode });
    return NextResponse.json(ok(result));
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}
