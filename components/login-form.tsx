"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

function safeNextPath(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not sign in");
      router.replace(safeNextPath(nextPath));
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="login-brand">
          <p className="eyebrow">Spark Intelligence</p>
          <Image
            src="/logo_sarkop_red.png"
            alt="Sarkop"
            width={3166}
            height={1590}
            priority
          />
        </div>
        <div>
          <h1>Welcome back</h1>
          <p className="subtitle">Sign in to view live sales and manage your stores.</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>Username</span>
            <input
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
