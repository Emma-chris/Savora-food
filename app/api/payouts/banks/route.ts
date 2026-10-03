import { NextResponse, type NextRequest } from "next/server";
import { ok, toEnvelope } from "@/server/errors";
import { ROLES, requireRole } from "@/server/auth/guard";
import { listBanks } from "@/server/payments/transfers";

let cachedAt = 0;
let cached: { name: string; slug: string; code: string }[] | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bank list for any payout form (vendor or rider). Cached 24h. */
export async function GET(request: NextRequest) {
  try {
    await requireRole(request, [ROLES.VENDOR, ROLES.DELIVERY_PARTNER, ROLES.ADMIN, ROLES.SUPER_ADMIN]);
    if (!cached || Date.now() - cachedAt > CACHE_TTL_MS) {
      const banks = await listBanks();
      cached = banks.map((bank) => ({ name: bank.name, slug: bank.slug, code: bank.code }));
      cachedAt = Date.now();
    }
    return NextResponse.json(ok(cached));
  } catch (error) {
    const { envelope, status } = toEnvelope(error);
    return NextResponse.json(envelope, { status });
  }
}