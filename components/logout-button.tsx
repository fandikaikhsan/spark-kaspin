"use client";

import { useState, type ReactNode } from "react";

export function LogoutButton({ className = "text-button", children, ariaLabel }: { className?: string; children?: ReactNode; ariaLabel?: string } = {}) {
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <button className={className} type="button" onClick={logout} disabled={loading} aria-label={loading ? "Signing out" : ariaLabel}>
      {children || (loading ? "Signing out…" : "Sign out")}
    </button>
  );
}
