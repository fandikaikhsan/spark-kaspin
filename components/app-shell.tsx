"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AnalyticsStore } from "@/lib/analytics/types";
import { Icon } from "./dashboard-charts";
import { LogoutButton } from "./logout-button";
import styles from "./dashboard.module.css";

export function AppShell({ children, stores, storeId, onStoreChange, user, status }: {
  children: ReactNode; stores: AnalyticsStore[]; storeId?: string; onStoreChange?: (id: string) => void;
  user?: { username: string; role: "admin" | "super_admin" }; status?: ReactNode;
}) {
  const pathname = usePathname(), search = useSearchParams(), router = useRouter();
  const [open, setOpen] = useState<"inventory" | "catalogue" | null>(null);
  const nav = useRef<HTMLElement>(null);
  const selected = storeId || search.get("store") || stores[0]?.id || "";
  const catalogue = ["/items", "/bases", "/products"].includes(pathname);
  const inventory = ["/stock-opname", "/receiving"].includes(pathname);
  useEffect(() => { setOpen(null); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!nav.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  function switchStore(id: string) {
    if (onStoreChange) onStoreChange(id);
    else { const params = new URLSearchParams(search.toString()); params.set("store", id); router.push(`${pathname}?${params}`); }
  }
  const href = (path: string) => selected ? `${path}?store=${encodeURIComponent(selected)}` : path;
  return <div className={styles.root}><div className={styles.app}>
    <header className={styles.topbar}>
      <Link href={href("/")} className={styles.brand} aria-label="Sarkop dashboard"><Image src="/logo_sarkop_red.png" alt="Sarkop" width={3166} height={1590} priority /></Link>
      <label className={styles.storePicker}><Icon name="pin" /><span className="sr-only">Store</span><select value={stores.some((store) => store.id === selected) ? selected : stores[0]?.id || ""} onChange={(event) => switchStore(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <div className={styles.topbarSpace} />{status}
      <div className={styles.account}><span className={styles.avatar}>{(user?.username || "Account").slice(0, 2).toUpperCase()}</span><span>{user?.username || "Account"}<small>{user?.role === "super_admin" ? "Owner" : "Manager"}</small></span></div>
    </header>
    <div className={styles.body}>
      <nav className={styles.sidebar} aria-label="Main navigation" ref={nav}>
        <Link href={href("/")} className={`${styles.navButton} ${pathname === "/" || pathname === "/transactions" ? styles.activeNav : ""}`} aria-label="Dashboard" aria-current={pathname === "/" ? "page" : undefined} title="Dashboard"><Icon name="chart" /></Link>
        <div className={styles.navGroup}><button className={`${styles.navButton} ${inventory ? styles.activeNav : ""}`} aria-label="Inventory" title="Inventory" aria-expanded={open === "inventory"} aria-controls="inventory-navigation" onClick={() => setOpen(open === "inventory" ? null : "inventory")}><Icon name="boxes" /></button>{open === "inventory" && <div className={styles.flyout} id="inventory-navigation"><strong>Inventory</strong><span className={styles.futureNav}>Overview <small>Coming later</small></span><Link href={href("/stock-opname")} aria-current={pathname === "/stock-opname" ? "page" : undefined}>Stock opname</Link><Link href={href("/receiving")} aria-current={pathname === "/receiving" ? "page" : undefined}>Receiving</Link></div>}</div>
        <button className={styles.navButton} disabled aria-label="Purchasing, coming later" title="Purchasing · coming later"><Icon name="cart" /></button>
        <div className={styles.navGroup}><button className={`${styles.navButton} ${catalogue ? styles.activeNav : ""}`} aria-label="Catalogue" title="Catalogue" aria-expanded={open === "catalogue"} aria-controls="catalogue-navigation" onClick={() => setOpen(open === "catalogue" ? null : "catalogue")}><Icon name="book" /></button>{open === "catalogue" && <div className={styles.flyout} id="catalogue-navigation"><strong>Catalogue</strong>{["Items", "Bases", "Products"].map((label) => <Link key={label} href={href(`/${label.toLowerCase()}`)} aria-current={pathname === `/${label.toLowerCase()}` ? "page" : undefined}>{label}</Link>)}</div>}</div>
        <Link href="/settings" className={`${styles.navButton} ${pathname === "/settings" ? styles.activeNav : ""}`} aria-label="Settings" title="Settings"><Icon name="settings" /></Link>
        <div className={styles.sidebarSpace} /><LogoutButton className={styles.navButton} ariaLabel="Sign out"><Icon name="logout" /></LogoutButton>
      </nav>
      <div className={styles.content}>{children}</div>
    </div>
  </div></div>;
}
