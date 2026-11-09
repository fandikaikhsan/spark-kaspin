"use client";

import { useState } from "react";

export function LogoutButton({ onBeforeLogout }: { onBeforeLogout?: () => boolean } = {}) {
  const [loading, setLoading] = useState(false);

  async function logout() {
    if (onBeforeLogout && !onBeforeLogout()) return;
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <button className="text-button" type="button" onClick={logout} disabled={loading}>
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
