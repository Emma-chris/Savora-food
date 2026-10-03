import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, toEnvelope } from "@/server/errors";
import { ROLES, requireRole } from "@/server/auth/guard";
import { getRiderContext } from "@/server/riders";
import { getPayoutAccount, savePayoutAccount } from "@/server/payouts";
import type { Owner } from "@/server/wallet";

const saveSchema = z.object({
  accountNumber: z.string().trim().regex(/^\d{10}$/, "Enter a valid 10-digit account number."),
  bankCode: z.string().trim().min(1, "Select a bank.").max(20),
});

/**
 * The rider's payout account. Same service the vendor rail uses — the owner
 * row is derived from the session's rider profile, so a rider can never
 * read or write another rider's bank details.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(request, [ROLES.DELIVERY_PARTNER]);
    const rider = await getRiderContext(session.id);
    const owner: Owner = { type: "RIDER", id: rider.id };
    return NextResponse.json(ok(await getPayoutAccount(owner)));
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(request, [ROLES.DELIVERY_PARTNER]);
    const rider = await getRiderContext(session.id);
    const parsed = saveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw ApiError.validation("Please fix the errors in your submission.", parsed.error.flatten().fieldErrors);
    }

    const owner: Owner = { type: "RIDER", id: rider.id };
    const saved = await savePayoutAccount(owner, parsed.data);
    return NextResponse.json(ok(saved), { status: saved.reused ? 200 : 201 });
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}