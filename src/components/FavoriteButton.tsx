"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { ApiRequestError } from "@/lib/savora-api";
import { useFavorites, useToggleFavorite } from "@/lib/api/hooks";

type FavoriteButtonProps = {
  productId?: string;
  vendorId?: string;
  label?: string;
};

/**
 * Heart toggle wired to the real favorites API (POST /api/favorites toggles).
 * Initial state comes from the shared favorites query; signed-out users are
 * sent to sign in instead of toggling a fake local-only state.
 */
export default function FavoriteButton({ productId, vendorId, label = "Add to favorites" }: FavoriteButtonProps) {
  const router = useRouter();
  const { data } = useFavorites();
  const toggle = useToggleFavorite();
  const [busy, setBusy] = useState(false);

  const targetId = productId ?? vendorId ?? null;
  const savedIds = productId
    ? data?.products.map((favorite) => favorite.product.id) ?? []
    : (data?.vendors.map((favorite) => favorite.vendor.id) ?? []);
  const saved = targetId !== null && savedIds.includes(targetId);

  async function onToggle() {
    if ((!productId && !vendorId) || busy) return;
    setBusy(true);
    try {
      await toggle.mutateAsync({ productId, vendorId });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        router.push("/auth");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`fav-btn${saved ? " saved" : ""}`}
      aria-label={saved ? "Remove from favorites" : label}
      aria-pressed={saved}
      disabled={busy}
      onClick={onToggle}
    >
      <Heart className="fav-ico" aria-hidden="true" />
    </button>
  );
}
