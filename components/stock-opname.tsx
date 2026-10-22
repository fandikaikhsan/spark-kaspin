"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import type { Store } from "@/lib/stores";
import { COUNTERS, RESTOCK_INSTRUCTION, STOCK_FIELDS, type StockSection } from "@/lib/stock-opname/template";
import { parseStockOpname, type StockOpname } from "@/lib/stock-opname/model";
import styles from "./stock-opname.module.css";

const sections: { key: StockSection; title: string; hint: string }[] = [
  { key: "prep", title: "Prep stock", hint: "Untuk persiapan besok. Tidak masuk inventori." },
  { key: "inventory", title: "Inventory stock", hint: "Isi jumlah sesuai satuan. Boleh 0 atau desimal." },
  { key: "restock", title: "Perlu restock?", hint: RESTOCK_INSTRUCTION },
];
function today(store?: Store) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: store?.timeZone || "Asia/Makassar", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
async function responseError(response: Response) {
  if (response.status === 401) window.location.assign("/login?next=/stock-opname");
  const data = await response.json().catch(() => ({}));
  return data.error || "Gagal menghubungi server. Coba lagi; isian tetap tersimpan di formulir ini.";
}
function dateLabel(value: string) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); }

export function StockOpnamePage({ stores, initialSubmissions, initialError, initialDate }: {
  stores: Store[]; initialSubmissions: StockOpname[]; initialError: string | null; initialDate: string;
}) {
  const [storeId, setStoreId] = useState(stores[0]?.id || "");
  const [countDate, setCountDate] = useState(initialDate);
  const [countedBy, setCountedBy] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [submissions, setSubmissions] = useState(initialSubmissions);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const inFlight = useRef(false);
  const historyRequest = useRef(0);
  const completed = STOCK_FIELDS.filter((field) => field.section === "restock" ? typeof answers[field.key] === "boolean" : typeof answers[field.key] === "string" && String(answers[field.key]).trim() !== "").length;

  async function refreshHistory(id: string) {
    const request = ++historyRequest.current; setLoading(true); setHistoryError(null);
    try {
      const response = await fetch(`/api/stock-opname?store=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json();
      if (request === historyRequest.current) setSubmissions(data.submissions);
    } catch (error) { if (request === historyRequest.current) setHistoryError(error instanceof Error ? error.message : "Riwayat gagal dimuat"); }
    finally { if (request === historyRequest.current) setLoading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || savedId) return;
    setError(null);
    try {
      const values = Object.fromEntries(STOCK_FIELDS.map((field) => [field.key, field.section === "restock" ? answers[field.key] : typeof answers[field.key] === "string" && String(answers[field.key]).trim() !== "" ? Number(answers[field.key]) : null]));
      token.current ??= crypto.randomUUID();
      const input = parseStockOpname({ id: token.current, storeId, countDate, countedBy, answers: values });
      inFlight.current = true; setBusy(true);
      const response = await fetch("/api/stock-opname", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json(); setSavedId(result.id);
      await refreshHistory(storeId);
    } catch (error) { setError(error instanceof Error ? error.message : "Stock opname gagal disimpan"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function reset() { setAnswers({}); setCountedBy(""); setCountDate(today(stores.find((store) => store.id === storeId))); token.current = null; setSavedId(null); setError(null); }

  return <main className={`shell ${styles.shell}`}>
    <header className={`subpage-header ${styles.header}`}><div><p className="eyebrow">Spark Intelligence · Operasional</p><h1>Stock opname</h1><p className="subtitle">Hitung stok, isi jumlah, lalu simpan.</p></div>
      <nav className="header-actions" aria-label="Account and navigation"><Link className="back-link" href="/">Dashboard</Link><Link className="back-link" href="/items">Items</Link><Link className="back-link" href="/bases">Bases</Link><Link className="back-link" href="/products">Products</Link><Link className="back-link" href="/receiving">Receiving</Link><LogoutButton /></nav>
    </header>
    {!stores.length && <p className="error" role="alert">Tidak ada toko aktif. Periksa koneksi database dan pengaturan toko, lalu muat ulang halaman.</p>}
    <form onSubmit={(event) => void submit(event)} aria-label="Form stock opname" className={styles.form}>
      <fieldset disabled={busy || Boolean(savedId) || !stores.length} className={styles.fieldset}>
        <div className={styles.meta}>
          <label><span>Toko *</span><select required value={storeId} onChange={(event) => { const id = event.target.value; setStoreId(id); setCountDate(today(stores.find((store) => store.id === id))); setSubmissions([]); void refreshHistory(id); }}><option value="" disabled>Pilih toko</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
          <label><span>Nama *</span><select required value={countedBy} onChange={(event) => setCountedBy(event.target.value)}><option value="" disabled>Siapa yang menghitung?</option>{COUNTERS.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label><span>Tanggal *</span><input type="date" required min="0001-01-01" max="9999-12-31" value={countDate} onChange={(event) => setCountDate(event.target.value)} /></label>
        </div>
        <div className={styles.sections}>{sections.map((section, sectionIndex) => <section key={section.key} className={`${styles.section} ${styles[section.key]}`} aria-labelledby={`${section.key}-heading`}>
          <div className={styles.sectionHeading}><span className={styles.number}>{String(sectionIndex + 1).padStart(2, "0")}</span><div><h2 id={`${section.key}-heading`}>{section.title}</h2><p>{section.hint}</p></div></div>
          <div className={styles.rows}>{STOCK_FIELDS.filter((field) => field.section === section.key).map((field) => field.section === "restock" ? <div className={styles.row} key={field.key} role="group" aria-labelledby={`${field.key}-label`}>
            <span id={`${field.key}-label`} className={styles.itemName}>{field.name}</span>
            <div className={styles.choices}>{[true, false].map((value) => <label key={String(value)}><input type="radio" name={field.key} required checked={answers[field.key] === value} onChange={() => setAnswers((previous) => ({ ...previous, [field.key]: value }))} aria-label={`${field.name}: ${value ? "Ya" : "Tidak"}`} /><span>{value ? "Ya" : "Tidak"}</span></label>)}</div>
          </div> : <label className={styles.row} key={field.key}>
            <span className={styles.itemName}>{field.name}<small>{field.uom}{field.note && <em> · {field.note}</em>}</small></span>
            <input type="number" inputMode="decimal" required min="0" max="1000000000000" step="any" aria-label={`${field.name} (${field.uom})`} placeholder="—" value={typeof answers[field.key] === "string" ? answers[field.key] as string : ""} onChange={(event) => setAnswers((previous) => ({ ...previous, [field.key]: event.target.value }))} />
          </label>)}</div>
        </section>)}</div>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {savedId ? <div className={styles.receipt} role="status"><div><strong>Stock opname tersimpan.</strong><p>{countedBy} · {dateLabel(countDate)} · {stores.find((store) => store.id === storeId)?.name}</p></div><button type="button" onClick={reset}>Isi stock opname baru</button></div> : <div className={styles.actions}><div><strong>{completed} / 40 barang</strong><span>Semua wajib diisi. Isi 0 jika stok kosong.</span></div><button type="submit" disabled={busy || !stores.length}>{busy ? "Menyimpan…" : "Simpan stock opname"}</button></div>}
    </form>
    <details className={styles.history}><summary>Riwayat tersimpan <span>10 terakhir · toko terpilih</span></summary><div className={styles.historyBody}>
      <button className={styles.refresh} disabled={loading || !storeId || busy} onClick={() => void refreshHistory(storeId)} type="button">{loading ? "Memuat…" : "Muat ulang riwayat"}</button>
      {historyError && <p className="error" role="alert">{historyError}</p>}
      {!submissions.length && !loading && !historyError && <p className={styles.empty}>Belum ada stock opname tersimpan.</p>}
      {submissions.map((submission) => <details key={submission.id} className={styles.submission}><summary><strong>{dateLabel(submission.countDate)}</strong> · {submission.countedBy}<small>Disimpan {new Intl.DateTimeFormat("id-ID", { dateStyle: "short", timeStyle: "short", timeZone: stores.find((store) => store.id === submission.storeId)?.timeZone || "Asia/Makassar" }).format(new Date(submission.submittedAt))}</small></summary>
        <div className={styles.savedSections}>{sections.map((section) => <section key={section.key}><h3>{section.title}</h3>{submission.lines.filter((line) => line.section === section.key).map((line) => <div className={styles.savedRow} key={line.key}><span>{line.name}</span><strong>{line.quantity === null ? line.needsRestock ? "Ya" : "Tidak" : `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 9 }).format(line.quantity)} ${line.uom}`}</strong></div>)}</section>)}</div>
      </details>)}
    </div></details>
  </main>;
}
