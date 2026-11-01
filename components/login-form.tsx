"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./login-form.module.css";

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
    <main className={`login-shell ${styles.shell}`}>
      <section className={`login-card ${styles.card}`}>
        <div className="login-brand">
          <Image
            src="/logo_sarkop_red.png"
            alt="Sarkop"
            width={3166}
            height={1590}
            priority
          />
        </div>
        <div>
          <h1>Masuk dashboard</h1>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>Username</span>
            <input
              autoComplete="username"
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
            {loading ? "Signing in…" : "Masuk"}
          </button>
        </form>
        <section className={styles.employeeEntry} aria-labelledby="employee-entry-heading"><h2 id="employee-entry-heading">Untuk tim toko</h2><p>Tanpa login</p>
          <Link href="/staff/stock-opname"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 5H6a2 2 0 0 0-2 2v13h16V7a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="6" rx="2"/><path d="M8 12h8M8 16h6"/></svg><span>Stock opname</span><span aria-hidden="true">›</span></Link>
          <Link href="/staff/receiving"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5"/></svg><span>Receiving</span><span aria-hidden="true">›</span></Link>
        </section>
      </section>
    </main>
  );
}
