import { createHash } from "node:crypto";

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
};

export function getCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: process.env.CLOUDINARY_FOLDER?.trim() || "savora",
  };
}

export function isCloudinaryConfigured(): boolean {
  return getCloudinaryConfig() !== null;
}

function signParams(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("sha1").update(`${toSign}${apiSecret}`).digest("hex");
}

/**
 * Signed server-side upload to Cloudinary (no extra SDK dependency).
 * Throws on misconfiguration or non-OK responses.
 */
export async function uploadImageToCloudinary(
  bytes: Buffer,
  contentType: string,
  filename: string,
): Promise<{ url: string; publicId: string }> {
  const config = getCloudinaryConfig();
  if (!config) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
    );
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const params: Record<string, string> = {
    folder: config.folder,
    timestamp,
  };
  const signature = signParams(params, config.apiSecret);

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  form.append("api_key", config.apiKey);
  form.append("timestamp", timestamp);
  form.append("folder", config.folder);
  form.append("signature", signature);

  const endpoint = `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`;
  const response = await fetch(endpoint, { method: "POST", body: form });
  const payload = (await response.json().catch(() => null)) as {
    secure_url?: string;
    public_id?: string;
    error?: { message?: string };
  } | null;

  if (!response.ok || !payload?.secure_url) {
    throw new Error(payload?.error?.message ?? `Cloudinary upload failed (${response.status})`);
  }

  return { url: payload.secure_url, publicId: payload.public_id ?? "" };
}
