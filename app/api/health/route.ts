import { NextResponse } from "next/server";

/**
 * Liveness check for Vercel / uptime monitors. Deliberately avoids touching
 * the database or reading required secrets so it stays green during builds
 * and when env is partially configured.
 */
export async function GET() {
  return NextResponse.json(
    {
      success: true,
      data: {
        ok: true,
        version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
        region: process.env.VERCEL_REGION ?? "local",
        env: {
          database: Boolean(process.env.DATABASE_URL?.trim()),
          jwt: Boolean(process.env.JWT_SECRET?.trim()),
          cloudinary: Boolean(
            process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
              process.env.CLOUDINARY_API_KEY?.trim() &&
              process.env.CLOUDINARY_API_SECRET?.trim(),
          ),
          paystack: Boolean(process.env.PAYSTACK_SECRET_KEY?.trim()),
          email: Boolean(
            process.env.BREVO_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim(),
          ),
        },
      },
    },
    { status: 200 },
  );
}
