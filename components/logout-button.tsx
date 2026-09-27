"use client";

import { useState } from "react";

export function LogoutButton() {
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
    <button className="text-button" type="button" onClick={logout} disabled={loading}>
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
