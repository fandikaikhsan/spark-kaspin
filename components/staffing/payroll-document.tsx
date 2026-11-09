"use client";
import { useEffect, useState } from "react";
type Recipient = { staff_name: string; staff_code: string; recipient_linked: boolean; recipient_version: string; delivery_state: string | null };
export function PayrollDocument({ payrollId, draft }: { payrollId?: string; draft?: { staff: string; from: string; to: string; version: string } }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState(""), [error, setError] = useState(""), [recipient, setRecipient] = useState<Recipient | null>(null), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [retry, setRetry] = useState(0);
  const query = payrollId ? `payroll=${payrollId}` : new URLSearchParams(draft || {}).toString();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); let blobUrl = "";
    setError(""); setUrl(""); setRecipient(null); setSent(false);
    Promise.all([fetch(`/api/staffing/payroll/document?${query}`, { cache: "no-store", signal: controller.signal }).then(async response => { if (!response.ok) { const value = await response.json(); throw new Error(value.error || "PDF belum tersedia."); } const blob = await response.blob(); if (!controller.signal.aborted) { blobUrl = URL.createObjectURL(blob); setUrl(blobUrl); } }),
      payrollId ? fetch(`/api/staffing/payroll/document?payroll=${payrollId}&format=metadata`, { cache: "no-store", signal: controller.signal }).then(async response => { if (!response.ok) throw new Error("Informasi penerima belum tersedia."); const value = await response.json(); if (!controller.signal.aborted) setRecipient(value); }) : Promise.resolve(),
    ]).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "PDF belum tersedia."); });
    return () => { controller.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [open, query, payrollId, retry]);
  async function send() {
    if (!recipient || !payrollId) return; setBusy(true); setError("");
    try {
      const response = await fetch("/api/staffing/payroll/document", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payroll_id: payrollId, recipient_version: recipient.recipient_version }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || "Pengiriman gagal."); setSent(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Pengiriman gagal."); setRecipient(value => value ? { ...value, delivery_state: "uncertain" } : null); }
    finally { setBusy(false); }
  }
  return <section className="ops-payroll-document"><button type="button" className="ops-secondary" onClick={() => setOpen(value => !value)}>{open ? "Tutup pratinjau PDF" : `Pratinjau PDF${payrollId ? "" : " (draft)"}`}</button>
    {open && <><div className="ops-document-actions">{url && <a className="ops-secondary" href={url} download={`payroll${payrollId ? "-final" : "-draft"}.pdf`}>Download PDF</a>}{payrollId && recipient && <div><p className="ops-muted">Penerima: <strong>{recipient.staff_name} ({recipient.staff_code})</strong> · {recipient.recipient_linked ? "chat pribadi akun Telegram tertaut" : "akun Telegram belum tertaut / staf tidak aktif"}.</p><button type="button" className="ops-button" disabled={!url || !recipient.recipient_linked || busy || sent || ["sent", "sending", "uncertain"].includes(recipient.delivery_state || "")} onClick={send}>{sent || recipient.delivery_state === "sent" ? "PDF sudah dikirim" : busy ? "Mengirim…" : `Kirim PDF ke ${recipient.staff_name}`}</button>{["sending", "uncertain"].includes(recipient.delivery_state || "") && <p className="ops-muted">Periksa status pengiriman / chat staf sebelum mengirim ulang.</p>}</div>}</div>
      {error && <p className="ops-error" role="alert">{error} <button type="button" className="ops-link" disabled={busy} onClick={() => setRetry(value => value + 1)}>Muat ulang pratinjau</button></p>}{!url && !error ? <p className="ops-muted" role="status">Membuat PDF…</p> : url && <iframe title="Pratinjau slip payroll" src={url} />}{!payrollId && <p className="ops-muted">Draft dapat diunduh; pengiriman ke staf tersedia setelah payroll difinalisasi.</p>}
    </>}
  </section>;
}
