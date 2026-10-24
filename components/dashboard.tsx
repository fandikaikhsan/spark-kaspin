"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { LogoutButton } from "@/components/logout-button";
import { addDays, averageOrderValue, hourlyRevenue, localClock, percentageChange, productSales } from "@/lib/analytics/dashboard";
import type { DailyAnalytics, DashboardMode, DashboardReport, DashboardTotals } from "@/lib/analytics/types";
import { Delta, Icon, ProductMix, ReceiptCard, SalesChart, dateLabel, hours, money, number, sum } from "./dashboard-charts";
import { ItemHeatmap, ReportDetails } from "./dashboard-details";
import styles from "./dashboard.module.css";

export function Dashboard({ initialData, initialMode = "live", initialNow, user }: {
  initialData: DailyAnalytics; initialMode?: DashboardMode; initialNow: number; user?: { username: string; role: "admin" | "super_admin" };
}) {
  const [data, setData] = useState(initialData);
  const [mode, setMode] = useState<DashboardMode>(initialMode);
  const [date, setDate] = useState(initialData.date);
  const [storeId, setStoreId] = useState(initialData.store.id);
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(initialNow);
  const [openMenu, setOpenMenu] = useState<"inventory" | "catalogue" | null>(null);
  const [newReceipts, setNewReceipts] = useState<Set<string>>(new Set());
  const rail = useRef<HTMLDivElement>(null), nav = useRef<HTMLElement>(null), currentData = useRef(data);
  const store = data.stores.find((store) => store.id === storeId) || initialData.store;
  const clock = localClock(store.timeZone, new Date(now));
  const selectedDate = mode === "live" ? clock.date : date;
  const currentReport = report?.date === selectedDate && report.mode === mode && report.storeId === storeId ? report : null;
  const ready = mode === "monthly" ? currentReport !== null : data.date === selectedDate && data.store.id === storeId;
  const items = useMemo(() => mode === "monthly" ? currentReport?.hourlyItems || [] : data.hourlyItems, [mode, currentReport, data.hourlyItems]);
  const products = useMemo(() => productSales(items), [items]);
  const totals: DashboardTotals = mode === "monthly" ? {
    revenue: sum(currentReport?.daily.map((day) => day.revenue) || []), units: sum(currentReport?.daily.map((day) => day.units) || []), transactions: sum(currentReport?.daily.map((day) => day.transactions) || []),
  } : { revenue: data.totalRevenue, units: data.totalUnits, transactions: data.transactionCount };
  const comparison = currentReport?.comparison, aov = averageOrderValue(totals);
  const comparisonAov = comparison ? averageOrderValue(comparison) : null;
  const comparisonLabel = currentReport ? mode === "monthly"
    ? `vs ${dateLabel(currentReport.comparisonStart)}–${dateLabel(currentReport.comparisonEnd)}`
    : `vs ${dateLabel(currentReport.comparisonStart)}${currentReport.comparisonThrough ? `, through ${currentReport.comparisonThrough.slice(11, 16)}` : ""}` : "";
  const saleValues = mode === "monthly" ? currentReport?.daily.map((day) => day.revenue) || [] : hourlyRevenue(items);
  const saleLabels = mode === "monthly" ? currentReport?.daily.map((day) => String(Number(day.date.slice(8)))) || [] : hours.map((hour) => `${String(hour).padStart(2, "0")}:00`);
  const isToday = mode !== "monthly" && selectedDate === clock.date;
  const feedMatches = data.store.id === storeId && data.date === selectedDate;
  const syncAge = feedMatches && data.lastSyncedAt ? Math.max(0, (now - Date.parse(data.lastSyncedAt)) / 1000) : null;
  const syncText = mode !== "live" ? "Historical view" : !feedMatches ? "Loading…" : data.source === "demo" ? "Sample data" : syncAge === null ? "No successful sync yet" : syncAge < 60 ? `Synced ${Math.floor(syncAge)}s ago` : syncAge < 3600 ? `Synced ${Math.floor(syncAge / 60)}m ago` : `Synced ${Math.floor(syncAge / 3600)}h ago`;

  useEffect(() => { currentData.current = data; }, [data]);
  useEffect(() => { setNow(Date.now()); const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  useEffect(() => { window.history.replaceState(null, "", `/?${new URLSearchParams({ store: storeId, view: mode, date: selectedDate })}`); }, [mode, selectedDate, storeId]);
  useEffect(() => {
    if (mode === "monthly") { setLoading(false); return; }
    const controller = new AbortController();
    let active = true, inFlight = false;
    async function load(quiet: boolean) {
      if (inFlight) return;
      inFlight = true;
      if (!quiet) setLoading(true);
      try {
        const response = await fetch(`/api/analytics?${new URLSearchParams({ store: storeId, date: selectedDate })}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not refresh dashboard");
        if (!active) return;
        const next = payload as DailyAnalytics, previous = currentData.current;
        const sameFeed = previous.date === next.date && previous.store.id === next.store.id;
        const previousIds = new Set(previous.recentTransactions.map((receipt) => receipt.transactionCode));
        const arrivals = sameFeed ? next.recentTransactions.filter((receipt) => !previousIds.has(receipt.transactionCode)).map((receipt) => receipt.transactionCode) : [];
        currentData.current = next; setData(next); setError(null);
        if (arrivals.length) setNewReceipts(new Set(arrivals));
      } catch (reason) {
        if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not refresh dashboard");
      } finally { inFlight = false; if (active) setLoading(false); }
    }
    void load(false);
    const timer = mode === "live" ? window.setInterval(() => void load(true), Math.max(3, data.refreshSeconds) * 1000) : null;
    return () => { active = false; controller.abort(); if (timer !== null) window.clearInterval(timer); };
  }, [selectedDate, storeId, mode, refreshKey, data.refreshSeconds]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true, inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/analytics/report?${new URLSearchParams({ store: storeId, date: selectedDate, mode })}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { window.location.assign("/login"); return; }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load period details");
        if (active) { setReport(payload as DashboardReport); setReportError(null); }
      } catch (reason) {
        if (active && !controller.signal.aborted) setReportError(reason instanceof Error ? reason.message : "Could not load period details");
      } finally { inFlight = false; }
    }
    void load();
    const timer = mode === "live" ? window.setInterval(() => void load(), 60_000) : null;
    return () => { active = false; controller.abort(); if (timer !== null) window.clearInterval(timer); };
  }, [selectedDate, storeId, mode, refreshKey]);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => rail.current?.scrollTo({ left: rail.current.scrollWidth, behavior: "auto" }));
    setNewReceipts(new Set());
    return () => window.cancelAnimationFrame(id);
  }, [selectedDate, storeId, mode, ready]);
  useEffect(() => {
    if (!newReceipts.size) return;
    rail.current?.scrollTo({ left: rail.current.scrollWidth, behavior: "smooth" });
    const id = window.setTimeout(() => setNewReceipts(new Set()), 4000);
    return () => window.clearTimeout(id);
  }, [newReceipts]);
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: PointerEvent) => { if (!nav.current?.contains(event.target as Node)) setOpenMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenMenu(null); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [openMenu]);

  function changeMode(next: DashboardMode) {
    if (next === mode) return;
    if (next === "live") setDate(clock.date);
    else if (next === "daily" && mode === "live") setDate(addDays(clock.date, -1));
    setMode(next); setError(null); setReportError(null);
  }

  return <div className={styles.root}><div className={styles.app}>
    <header className={styles.topbar}><Link href="/" className={styles.brand} aria-label="Sarkop dashboard"><Image src="/logo_sarkop_red.png" alt="Sarkop" width={3166} height={1590} priority /></Link>
      <label className={styles.storePicker}><Icon name="pin" /><span className="sr-only">Store</span><select value={storeId} onChange={(event) => { const next = data.stores.find((store) => store.id === event.target.value); if (next) { const today = localClock(next.timeZone).date; setStoreId(next.id); setDate(mode === "live" || date > today ? today : date); setError(null); setReportError(null); } }}>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <div className={styles.topbarSpace} /><span className={styles.sync} title={data.lastSyncedAt ? new Intl.DateTimeFormat("en-GB", { timeZone: store.timeZone, dateStyle: "medium", timeStyle: "medium" }).format(new Date(data.lastSyncedAt)) : undefined}><i className={mode === "live" && (syncAge === null || syncAge > 60) && data.source !== "demo" ? styles.staleDot : ""} />{syncText}</span>
      <div className={styles.account}><span className={styles.avatar}>{(user?.username || "Account").slice(0, 2).toUpperCase()}</span><span>{user?.username || "Account"}<small>{user?.role === "super_admin" ? "Owner" : "Manager"}</small></span></div>
    </header>
    <div className={styles.body}><nav className={styles.sidebar} aria-label="Main navigation" ref={nav}>
      <Link href="/" className={`${styles.navButton} ${styles.activeNav}`} aria-label="Dashboard" aria-current="page" title="Dashboard"><Icon name="chart" /></Link>
      <div className={styles.navGroup}><button type="button" className={styles.navButton} aria-label="Inventory" title="Inventory" aria-expanded={openMenu === "inventory"} aria-controls="inventory-navigation" onClick={() => setOpenMenu(openMenu === "inventory" ? null : "inventory")}><Icon name="boxes" /></button>{openMenu === "inventory" && <div className={styles.flyout} id="inventory-navigation"><strong>Inventory</strong><span className={styles.futureNav}>Overview <small>Coming later</small></span><Link href="/stock-opname">Stock opname</Link><Link href="/receiving">Receiving</Link></div>}</div>
      <button type="button" className={styles.navButton} disabled aria-label="Purchasing, coming later" title="Purchasing · coming later"><Icon name="cart" /></button>
      <div className={styles.navGroup}><button type="button" className={styles.navButton} aria-label="Catalogue" title="Catalogue" aria-expanded={openMenu === "catalogue"} aria-controls="catalogue-navigation" onClick={() => setOpenMenu(openMenu === "catalogue" ? null : "catalogue")}><Icon name="book" /></button>{openMenu === "catalogue" && <div className={styles.flyout} id="catalogue-navigation"><strong>Catalogue</strong><Link href="/items">Items</Link><Link href="/bases">Bases</Link><Link href="/products">Products</Link></div>}</div>
      <Link href="/settings" className={styles.navButton} aria-label="Settings" title="Settings"><Icon name="settings" /></Link><div className={styles.sidebarSpace} /><LogoutButton className={styles.navButton} ariaLabel="Sign out"><Icon name="logout" /></LogoutButton>
    </nav>
    <main className={styles.content}><div className={styles.heading}><h1>Dashboard</h1><div className={styles.periodControls}><div className={styles.tabs} role="tablist" aria-label="Dashboard view">{(["live", "daily", "monthly"] as const).map((view) => <button type="button" key={view} id={`view-${view}`} role="tab" aria-selected={mode === view} aria-controls="dashboard-view" onClick={() => changeMode(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}</div><label className={styles.calendar}><span className="sr-only">{mode === "monthly" ? "Month" : "Business date"}</span><input type={mode === "monthly" ? "month" : "date"} value={mode === "monthly" ? selectedDate.slice(0, 7) : selectedDate} max={mode === "monthly" ? clock.date.slice(0, 7) : clock.date} onChange={(event) => { if (!event.target.value) return; const next = mode === "monthly" ? `${event.target.value}-01` : event.target.value; if (mode === "live" && next !== clock.date) setMode("daily"); setDate(next); setError(null); setReportError(null); }} /></label><button className={styles.refresh} type="button" aria-label="Refresh dashboard" title="Refresh dashboard" disabled={loading} onClick={() => setRefreshKey((key) => key + 1)}><Icon name="refresh" /></button></div></div>
      {data.source === "demo" && <div className={styles.notice}>Sample data · connect Supabase and sync transactions to see live sales.</div>}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {reportError && <div className={styles.notice} role="status">Period details unavailable: {reportError} <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Retry</button></div>}
      <div id="dashboard-view" role="tabpanel" aria-labelledby={`view-${mode}`} aria-busy={loading || !ready} className={styles.view}>
        {!ready ? <section className={`${styles.panel} ${styles.loading}`} role="status">{reportError || error ? "Unable to load this period. Use Refresh to try again." : "Loading sales for this period…"}</section> : <>
          <div className={styles.mainGrid}><div className={styles.salesStack}>
            <section className={`${styles.panel} ${styles.hero}`} aria-labelledby="gross-title"><h2 id="gross-title">Gross sales{mode === "monthly" && selectedDate.slice(0, 7) === clock.date.slice(0, 7) ? " · MTD" : ""}</h2><strong className={styles.grossValue}>{money(totals.revenue)}</strong><Delta value={percentageChange(totals.revenue, comparison?.revenue)} label={comparisonLabel} /><div className={styles.chartHeading}><span>Gross sales by {mode === "monthly" ? "day" : "hour"}</span><span>IDR</span></div><SalesChart values={saleValues} labels={saleLabels} partialIndex={isToday ? clock.hour : mode === "monthly" && currentReport?.endDate === clock.date ? saleValues.length - 1 : undefined} futureAfter={isToday ? clock.hour : undefined} /><div className={styles.chartLegend}><span><i />{mode === "monthly" ? dateLabel(`${selectedDate.slice(0, 7)}-01`, { month: "long" }) : dateLabel(selectedDate)}</span>{(isToday || mode === "monthly" && currentReport?.endDate === clock.date) && <span>Current {mode === "monthly" ? "day" : "hour"} is partial · {store.timeZone === "Asia/Makassar" ? "WITA" : "WIB"}</span>}</div></section>
            <div className={styles.kpis}><section className={`${styles.panel} ${styles.kpi}`}><h2><Icon name="package" />Items sold</h2><strong>{number.format(totals.units)}</strong><Delta value={percentageChange(totals.units, comparison?.units)} label={comparisonLabel} /></section><section className={`${styles.panel} ${styles.kpi}`}><h2><Icon name="receipt" />Transactions</h2><strong>{number.format(totals.transactions)}</strong><Delta value={percentageChange(totals.transactions, comparison?.transactions)} label={comparisonLabel} /></section><section className={`${styles.panel} ${styles.kpi} ${styles.aov}`}><h2><Icon name="wallet" />Avg order value</h2><strong>{aov === null ? "—" : money(aov)}</strong><Delta value={aov === null ? null : percentageChange(aov, comparisonAov)} label={comparisonLabel} /></section></div>
          </div><ProductMix products={products} /></div>
          {mode === "live" ? <><ItemHeatmap key={`${selectedDate}-${storeId}`} products={products} date={selectedDate} today={clock.date} currentHour={clock.hour} timeZone={store.timeZone} /><section className={`${styles.panel} ${styles.railPanel}`} aria-labelledby="receipts-title"><div className={styles.panelHeading}><h2 id="receipts-title">Recent transactions</h2><Link className={styles.sectionLink} href={`/transactions?${new URLSearchParams({ store: storeId, date: selectedDate })}`}>See all transactions <span aria-hidden="true">↗</span></Link></div>{data.recentTransactions.length ? <div className={`receipt-rail ${styles.receiptRail}`} ref={rail} aria-label="Live order rail, latest receipts on the right">{data.recentTransactions.map((receipt) => <ReceiptCard key={receipt.transactionCode} transaction={receipt} timeZone={store.timeZone} isNew={newReceipts.has(receipt.transactionCode)} />)}</div> : <div className={styles.empty}>No receipts have arrived for this date yet.</div>}</section></> : currentReport ? <ReportDetails report={currentReport} products={products} /> : <section className={styles.panel}><p className={styles.caption}>Loading period details…</p></section>}
        </>}
      </div>
    </main></div>
  </div></div>;
}
