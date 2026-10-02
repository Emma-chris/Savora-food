"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Heart, Home, Search, ShoppingCart, UserRound } from "lucide-react";
import CartCount from "./CartCount";
import { useCurrentUser } from "@/lib/api/hooks";
import { dashboardForRole } from "@/lib/savora-api";

/**
 * Fixed bottom tab bar for mobile (Lovable-style). Hidden on desktop where
 * the full header nav is available. Mounted in PageShell after the footer.
 */
export default function MobileTabBar() {
  const pathname = usePathname();
  const { data: currentUser } = useCurrentUser();

  const accountHref =
    currentUser && currentUser.role !== "CUSTOMER"
      ? dashboardForRole(currentUser.role)
      : currentUser
        ? "/dashboard?tab=overview"
        : "/auth";

  const tabs = [
    { label: "Home", href: "/", icon: Home, active: pathname === "/" },
    { label: "Search", href: "/search", icon: Search, active: pathname.startsWith("/search") },
    { label: "Cart", href: "/cart", icon: ShoppingCart, active: pathname.startsWith("/cart"), badge: true },
    {
      label: "Saved",
      href: "/dashboard?tab=favorites",
      icon: Heart,
      active: pathname.startsWith("/dashboard"),
    },
    {
      label: currentUser ? "Account" : "Login",
      href: accountHref,
      icon: UserRound,
      active:
        pathname.startsWith("/account") ||
        pathname.startsWith("/vendor") ||
        pathname.startsWith("/admin") ||
        pathname.startsWith("/rider") ||
        pathname.startsWith("/super-admin") ||
        pathname.startsWith("/auth") ||
        pathname.startsWith("/login") ||
        pathname.startsWith("/register"),
    },
  ];

  return (
    <nav className="mtab" aria-label="Mobile tabs">
      {tabs.map(({ label, href, icon: Icon, active, badge }) => (
        <Link
          key={label}
          href={href}
          className={active ? "mtab-link active" : "mtab-link"}
          aria-current={active ? "page" : undefined}
        >
          <span className="mtab-ico-wrap">
            <Icon className="mtab-ico" aria-hidden="true" />
            {badge ? <CartCount /> : null}
          </span>
          <span className="mtab-label">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
