"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import { navigationAllowed, type NavigationAccount, type NavigationNotifications } from "@/lib/navigation";

const roleLabels = { super_admin: "Super admin", admin: "Admin", manager: "Manager" };

export function AppNavbar({ account }: { account: NavigationAccount }) {
  const pathname = usePathname();
  const visible = pathname !== "/login";
  const [open, setOpen] = useState<"account" | "notifications" | null>(null);
  const [notifications, setNotifications] = useState<NavigationNotifications | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const notificationButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/staffing/notifications", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Notifikasi belum dapat dimuat. Coba lagi.");
      const data = await response.json() as NavigationNotifications;
      if (!controller.signal.aborted) { setNotifications(data); setError(""); }
    } catch {
      if (!controller.signal.aborted) { setError("Notifikasi belum dapat dimuat. Coba lagi."); setNotifications(null); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 60_000);
    return () => { request.current?.abort(); window.removeEventListener("focus", onFocus); window.clearInterval(timer); };
  }, [pathname, visible, refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(null);
        (open === "account" ? accountButton : notificationButton).current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!visible) return null;
  const isStaffing = pathname.startsWith("/staffing") || pathname === "/settings";
  const total = notifications?.total || 0;
  function onNavigate(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target as HTMLElement).closest("a")) return;
    if (!navigationAllowed()) event.preventDefault();
    else setOpen(null);
  }

  return <header className="app-navbar" ref={root} onClickCapture={onNavigate} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(null);
  }}>
    <div className="app-navbar-inner">
      <Link className="app-navbar-brand" href={account.role === "manager" ? "/staffing" : "/"} aria-label="Sarkop Intelligence, beranda">
        <Image src="/logo_sarkop_red.png" alt="Sarkop" width={112} height={56} priority />
        <span>Intelligence</span>
      </Link>
      <nav className="app-navbar-menu" aria-label="Menu utama">
        {account.role !== "manager" && <Link href="/" aria-current={!isStaffing ? "page" : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>Dashboard</Link>}
        <Link href="/staffing" aria-current={isStaffing ? "page" : undefined}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2" /></svg>Staffing</Link>
      </nav>
      <div className="app-navbar-actions">
        <div className="app-navbar-popover-anchor">
          <button type="button" className={`app-navbar-bell${open === "notifications" ? " is-open" : ""}`} aria-label={`Notifikasi${notifications ? `, ${total} item perlu tindakan` : ""}`} aria-expanded={open === "notifications"} aria-controls="navbar-notifications" ref={notificationButton} onClick={() => { setOpen(open === "notifications" ? null : "notifications"); if (open !== "notifications") void refresh(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
            {total > 0 && <span className="app-navbar-badge" aria-hidden="true">{total > 99 ? "99+" : total}</span>}
          </button>
          {open === "notifications" && <section className="app-navbar-popover app-notifications" id="navbar-notifications" aria-label="Notifikasi">
            <div className="app-popover-heading"><div><strong>Notifikasi</strong><p>Perlu tindakan dalam cakupan aksesmu</p></div><button type="button" className="app-notification-refresh" onClick={() => void refresh()} disabled={loading} aria-label="Muat ulang notifikasi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15" /></svg></button></div>
            <div className="app-notification-list" aria-busy={loading}>
              {error ? <div className="app-notification-empty" role="status"><strong>Belum tersedia</strong><p>{error}</p></div> : !notifications ? <p className="app-notification-empty" role="status">Memuat notifikasi…</p> : notifications.items.length ? notifications.items.map(item => <Link key={item.id} href={item.href} className="app-notification-item"><span className="app-notification-count">{item.count}</span><span><strong>{item.title}</strong><small>{item.description}</small></span><span aria-hidden="true">↗</span></Link>) : <div className="app-notification-empty" role="status"><span className="app-notification-check" aria-hidden="true">✓</span><strong>Semua sudah ditangani</strong><p>Tidak ada item yang perlu ditinjau pada cakupan ini.</p></div>}
            </div>
            <Link className="app-popover-footer" href="/staffing/activities">Lihat aktivitas <span aria-hidden="true">→</span></Link>
          </section>}
        </div>
        <div className="app-navbar-popover-anchor">
          <button type="button" className={`app-navbar-account${open === "account" ? " is-open" : ""}`} aria-label={`Akun ${account.username}`} aria-expanded={open === "account"} aria-controls="navbar-account" ref={accountButton} onClick={() => setOpen(open === "account" ? null : "account")}>
            <span className="app-navbar-avatar" aria-hidden="true">{account.username.slice(0, 2).toUpperCase()}</span><span className="app-navbar-account-label"><strong>{account.username}</strong><small>{roleLabels[account.role]}</small></span><svg className="app-navbar-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
          </button>
          {open === "account" && <section className="app-navbar-popover app-account" id="navbar-account" aria-label="Akun">
            <div className="app-popover-heading"><div><strong>{account.username}</strong><p>{roleLabels[account.role]}</p></div></div>
            {account.role !== "manager" && <Link className="app-account-link" href="/staffing/settings">Pengaturan <span aria-hidden="true">↗</span></Link>}
            <LogoutButton onBeforeLogout={navigationAllowed} />
          </section>}
        </div>
      </div>
    </div>
  </header>;
}
