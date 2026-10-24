"use client";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import { ReceivingItemPicker } from "@/components/receiving-item-picker";
import { EMPLOYEE_NAMES } from "@/lib/operations/employees";
import { parseReceiving, receivingUnits, type Receiving, type ReceivingItem } from "@/lib/receiving/model";
import type { Store } from "@/lib/stores";
import common from "./stock-opname.module.css";
import styles from "./receiving.module.css";

type DraftLine = { key: number; itemId: string; quantity: string; uom: string };
async function responseError(response: Response) {
  if (response.status === 401) window.location.assign("/login?next=/receiving");
  const data = await response.json().catch(() => ({}));
  return data.error || "Gagal menghubungi server. Coba lagi; isian tetap ada di formulir ini.";
}
export function ReceivingPage({ stores, items, initialReceivings, initialError }: {
  stores: Store[]; items: ReceivingItem[]; initialReceivings: Receiving[]; initialError: string | null;
}) {
  const [storeId, setStoreId] = useState(stores[0]?.id || "");
  const [receivedBy, setReceivedBy] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ key: 0, itemId: "", quantity: "", uom: "" }]);
  const nextKey = useRef(1);
  const [receivings, setReceivings] = useState(initialReceivings);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError); const [historyError, setHistoryError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const token = useRef<string | null>(null); const inFlight = useRef(false); const historyRequest = useRef(0);
  function update(key: number, patch: Partial<DraftLine>) { setLines((previous) => previous.map((row) => row.key === key ? { ...row, ...patch } : row)); }
  function timestamp(value: string) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: stores.find((store) => store.id === storeId)?.timeZone || "Asia/Makassar" }).format(new Date(value)); }
  async function refreshHistory(id: string) {
    const request = ++historyRequest.current; setLoading(true); setHistoryError(null);
    try {
      const response = await fetch(`/api/receiving?store=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json();
      if (request === historyRequest.current) setReceivings(data.receivings);
    } catch (error) { if (request === historyRequest.current) setHistoryError(error instanceof Error ? error.message : "Riwayat gagal dimuat"); }
    finally { if (request === historyRequest.current) setLoading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || savedId) return; setError(null);
    try {
      token.current ??= crypto.randomUUID();
      const input = parseReceiving({ id: token.current, storeId, receivedBy, lines: lines.map((line) => ({ itemId: line.itemId,
        uom: line.uom, quantity: line.quantity.trim() ? Number(line.quantity) : null, itemUpdatedAt: items.find((item) => item.id === line.itemId)?.updatedAt })) });
      inFlight.current = true; setBusy(true);
      const response = await fetch("/api/receiving", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json(); setSavedId(result.id);
      // A history refresh failure must not turn a successful save into a failed receipt.
      await refreshHistory(storeId);
    } catch (error) { setError(error instanceof Error ? error.message : "Receiving gagal disimpan"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function reset() { setReceivedBy(""); setLines([{ key: nextKey.current++, itemId: "", quantity: "", uom: "" }]); token.current = null; setSavedId(null); setError(null); }
  return <main className={`shell ${common.shell} ${styles.page}`}>
    <header className={`subpage-header ${common.header}`}><div><p className="eyebrow">Spark Intelligence · Operasional</p><h1>Receiving</h1><p className="subtitle">Catat barang yang datang, lalu simpan.</p></div>
      <nav className="header-actions" aria-label="Account and navigation"><Link className="back-link" href="/">Dashboard</Link><Link className="back-link" href="/items">Items</Link><Link className="back-link" href="/stock-opname">Stock Opname</Link><LogoutButton /></nav>
    </header>
    {!stores.length && <p className="error" role="alert">Tidak ada toko aktif. Periksa koneksi database dan pengaturan toko, lalu muat ulang halaman.</p>}
    <form onSubmit={(event) => void submit(event)} aria-label="Form receiving">
      <fieldset className={common.fieldset} disabled={busy || Boolean(savedId) || !stores.length || !items.length}>
        <div className={`${common.meta} ${styles.meta}`}>
          <label><span>Toko *</span><select aria-label="Toko" required value={storeId} onChange={(event) => { setStoreId(event.target.value); setReceivings([]); void refreshHistory(event.target.value); }}><option value="" disabled>Pilih toko</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
          <label><span>Nama penerima *</span><select aria-label="Nama penerima" required value={receivedBy} onChange={(event) => setReceivedBy(event.target.value)}><option value="" disabled>Siapa yang menerima?</option>{EMPLOYEE_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <p className={styles.timeNote}>Tanggal dan waktu dicatat otomatis saat disimpan.</p>
        </div>
        <section className={styles.panel} aria-labelledby="receiving-items-heading">
          <div className={styles.panelHeading}><h2 id="receiving-items-heading">Barang diterima</h2><p>Pilih satuan sesuai barang yang diterima. Satuan kemasan mengikuti ukuran yang diatur di Items.</p></div>
          {!items.length && <p className="notice">Belum ada barang tersedia. Tambahkan barang di <Link href="/items">Items</Link>, lalu muat ulang halaman ini.</p>}
          <div className={styles.rows}>{lines.map((line, index) => {
            const item = items.find((item) => item.id === line.itemId);
            return <div className={styles.row} key={line.key}>
              <span className={styles.index}>{String(index + 1).padStart(2, "0")}</span>
              <div className={styles.item}><span>Barang *</span><ReceivingItemPicker label={`Barang ${index + 1}`} value={line.itemId} items={items} onChange={(itemId) => update(line.key, { itemId, uom: items.find((entry) => entry.id === itemId)?.purchaseUnitName || "" })} /></div>
              <label className={styles.quantity}><span>Jumlah *</span><input aria-label={`Jumlah barang ${index + 1}`} type="number" inputMode="decimal" required min="0.000000001" max="1000000000000" step="any" placeholder="0" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} /></label>
              <label className={styles.unit}><span>Satuan *</span><select aria-label={`Satuan barang ${index + 1}`} required disabled={!item} value={line.uom} onChange={(event) => update(line.key, { uom: event.target.value })}>{!item && <option value="">Pilih barang</option>}{item && receivingUnits(item).map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
              <button className={styles.remove} type="button" disabled={lines.length === 1} aria-label={`Hapus barang ${index + 1}`} onClick={() => setLines((previous) => previous.filter((row) => row.key !== line.key))}>×</button>
            </div>;
          })}</div>
          <button className={styles.add} type="button" disabled={lines.length >= 100} onClick={() => { const key = nextKey.current++; setLines((previous) => [...previous, { key, itemId: "", quantity: "", uom: "" }]); }}>+ Tambah barang</button>
        </section>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {savedId ? <div className={common.receipt} role="status"><div><strong>Receiving tersimpan.</strong><p>{receivedBy} · {lines.length} barang · {stores.find((store) => store.id === storeId)?.name}</p></div><button type="button" onClick={reset}>Catat penerimaan baru</button></div> : <div className={common.actions}><div><strong>{lines.length} barang</strong><span>Isi jumlah yang benar-benar diterima.</span></div><button type="submit" disabled={busy || !stores.length || !items.length}>{busy ? "Menyimpan…" : "Simpan receiving"}</button></div>}
    </form>
    <details className={common.history}><summary>Riwayat penerimaan <span>10 terakhir · toko terpilih</span></summary><div className={common.historyBody}>
      <button className={common.refresh} type="button" disabled={busy || loading || !storeId} onClick={() => void refreshHistory(storeId)}>{loading ? "Memuat…" : "Muat ulang riwayat"}</button>
      {historyError && <p className="error" role="alert">{historyError}</p>}
      {!receivings.length && !loading && !historyError && <p className={common.empty}>Belum ada penerimaan tersimpan.</p>}
      {receivings.map((receiving) => <details className={common.submission} key={receiving.id}><summary><strong>{timestamp(receiving.receivedAt)}</strong> · {receiving.receivedBy}<small>{receiving.lines.length} barang</small></summary>
        <div className={styles.savedRows}>{receiving.lines.map((line) => <div className={styles.savedRow} key={line.itemId}><span>{line.name}<small>{line.itemId}</small></span><strong>{new Intl.NumberFormat("id-ID", { maximumFractionDigits: 9 }).format(line.quantity)} {line.uom}</strong></div>)}</div>
      </details>)}
    </div></details>
  </main>;
}
