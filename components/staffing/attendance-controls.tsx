"use client";
import { storeOffset } from "@/lib/store-timezone";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { localTime } from "@/lib/staffing/model";
import { stateLabels, type ReviewedSession } from "@/lib/staffing/operations-model";
import { TimeChip } from "./time-chip";
import { AttendanceChips } from "./attendance-chips";

function displayTime(value: string, zone: string, seconds = false) {
  const [date, time] = localTime(value, zone, seconds).split("T");
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year} ${time}`;
}

type Evidence = { attempt_id: string; kind: string; latitude: number; longitude: number; effective_at: string };
export function AttendanceControls({ session }: { session: ReviewedSession }) {
  const router = useRouter();
  const initialIn = localTime(session.corrected_in_at || session.check_in_at, session.time_zone, true);
  const initialOut = (session.corrected_out_at || session.check_out_at) ? localTime((session.corrected_out_at || session.check_out_at)!, session.time_zone, true) : "";
  const [entered, setEntered] = useState(initialIn), [exited, setExited] = useState(initialOut);
  const [decision, setDecision] = useState(session.verification_state), [note, setNote] = useState(session.review_note || "");
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState("");
  const [evidence, setEvidence] = useState<Evidence[]>([]), [loadingEvidence, setLoadingEvidence] = useState(true), [evidenceError, setEvidenceError] = useState("");
  const [retry, setRetry] = useState(0), [photoErrors, setPhotoErrors] = useState<string[]>([]);
  const key = useRef<string | null>(null);
  useEffect(() => { setEntered(initialIn); setExited(initialOut); setDecision(session.verification_state); setNote(session.review_note || ""); setEditing(false); key.current = null; }, [session.id, session.review_version, initialIn, initialOut, session.verification_state, session.review_note]);
  useEffect(() => {
    const controller = new AbortController(); setLoadingEvidence(true); setEvidenceError("");
    fetch(`/api/staffing/evidence?session=${session.id}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const value = await response.json(); if (controller.signal.aborted) return;
      if (response.status === 404) { setEvidence([]); return; }
      if (!response.ok) throw new Error(value.error || "Bukti belum dapat dimuat.");
      setEvidence(value);
    }).catch(err => { if (!controller.signal.aborted) setEvidenceError(err instanceof Error ? err.message : "Bukti belum dapat dimuat."); })
      .finally(() => { if (!controller.signal.aborted) setLoadingEvidence(false); });
    return () => controller.abort();
  }, [session.id, retry]);
  const timesChanged = entered !== initialIn || exited !== initialOut;
  const dirty = timesChanged || decision !== session.verification_state || note.trim() !== (session.review_note || "").trim();
  const validTimes = !!entered && (!exited || exited >= entered) && (!session.check_out_at || !!exited);
  const locked = !!session.payroll_locked;
  const canSave = dirty && note.trim().length >= 5 && validTimes && !locked && !busy && !saved;
  const offset = storeOffset(session.time_zone);
  const preview = { ...session, corrected_in_at: entered ? entered + offset : null, corrected_out_at: exited ? exited + offset : null };
  function changed() { setSaved(false); setError(""); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canSave) return;
    key.current ??= crypto.randomUUID(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/staffing/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "review_attendance", data: { session_id: session.id, version: session.review_version, client_id: key.current, state: decision, note: note.trim(), correct_times: timesChanged, check_in_local: entered, check_out_local: exited } }) });
      const value = await response.json(); if (!response.ok) { if (response.status === 409) router.refresh(); throw new Error(value.error || "Review belum dapat disimpan."); }
      setSaved(true); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Review belum dapat disimpan."); }
    finally { setBusy(false); }
  }
  return <form className="ops-review-form" onSubmit={submit}>
    <fieldset disabled={busy}>
      <section className="ops-review-times"><div className="ops-section-heading"><div><h3>Jadwal & waktu absensi</h3><p className="ops-review-range"><TimeChip value={session.starts_at} zone={session.time_zone} /><span>–</span><TimeChip value={session.ends_at} zone={session.time_zone} /></p></div><button className="ops-edit-time" type="button" disabled={locked} aria-label={editing ? "Selesai edit waktu absensi" : "Edit waktu absensi"} aria-pressed={editing} onClick={() => setEditing(value => !value)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15l-1 6Z" /></svg>{editing ? "Selesai edit" : "Edit waktu"}</button></div>
        <div className="ops-review-time-grid"><div><span>Masuk tercatat</span>{editing ? <input aria-label="Waktu masuk aktual" type="datetime-local" step={1} value={entered} required onChange={event => { setEntered(event.target.value); changed(); }} /> : <TimeChip value={session.corrected_in_at || session.check_in_at} zone={session.time_zone} />}</div><div><span>Pulang tercatat</span>{editing ? <input aria-label="Waktu pulang aktual" type="datetime-local" step={1} value={exited} min={entered} required={!!session.check_out_at} onChange={event => { setExited(event.target.value); changed(); }} /> : (session.corrected_out_at || session.check_out_at) ? <TimeChip value={(session.corrected_out_at || session.check_out_at)!} zone={session.time_zone} /> : <strong>Belum checkout</strong>}</div></div>
        <AttendanceChips session={preview} />
        {(session.corrected_in_at || session.corrected_out_at) && <p className="ops-muted">Data asli: {displayTime(session.check_in_at, session.time_zone, true)} – {session.check_out_at ? displayTime(session.check_out_at, session.time_zone, true) : "Belum checkout"}.</p>}
        {editing && <p className="ops-muted">Koreksi waktu aktual di sini. Selisih di luar jadwal dihitung sebagai lembur setelah review dikonfirmasi.</p>}
      </section>
      <section className="ops-review-evidence"><h3>Bukti absensi</h3>{loadingEvidence ? <p className="ops-muted" role="status">Memuat foto dan lokasi…</p> : evidenceError ? <p className="ops-error">{evidenceError} <button type="button" className="ops-link" onClick={() => setRetry(value => value + 1)}>Coba lagi</button></p> : !evidence.length ? <p className="ops-muted">Belum ada foto atau lokasi yang dilampirkan pada sesi ini.</p> : <div className="ops-evidence-grid">{evidence.map(item => <article key={item.attempt_id}><span className="ops-eyebrow">{item.kind === "check_in" ? "Bukti masuk" : "Bukti pulang"}</span>{photoErrors.includes(item.attempt_id) ? <p className="ops-photo-fallback">Foto belum tersedia di dashboard.</p> : <a href={`/api/staffing/evidence?attempt=${item.attempt_id}`} target="_blank" rel="noreferrer"><Image unoptimized width={360} height={200} src={`/api/staffing/evidence?attempt=${item.attempt_id}`} alt={`Foto absensi ${item.kind === "check_in" ? "masuk" : "pulang"}`} onError={() => setPhotoErrors(values => [...values, item.attempt_id])} /></a>}<p>{item.latitude}, {item.longitude}</p><p className="ops-muted">{displayTime(item.effective_at, session.time_zone)}</p><a className="ops-inline-link" href={`https://www.google.com/maps?q=${item.latitude},${item.longitude}`} target="_blank" rel="noreferrer">Buka peta eksternal ↗</a></article>)}</div>}</section>
      <section className="ops-review-decision"><h3>Review manager</h3><div className="ops-review-fields"><label>Status review<select value={decision} disabled={locked} onChange={event => { setDecision(event.target.value as typeof decision); changed(); }}><option value="pending">Menunggu review</option><option value="confirmed">Konfirmasi absensi</option><option value="rejected">Tolak absensi</option></select></label><label>Catatan review / alasan koreksi<textarea value={note} disabled={locked} minLength={5} maxLength={1000} required rows={3} placeholder="Catatan pemeriksaan, minimal 5 karakter" onChange={event => { setNote(event.target.value); changed(); }} /></label></div><p className="ops-muted">Status saat ini: {stateLabels[session.verification_state]}. Konfirmasi menyetujui waktu aktual beserta lembur di luar jadwal.</p>{locked && <p className="ops-muted">Absensi ini sudah masuk payroll final sehingga tidak dapat diubah.</p>}</section>
    </fieldset>
    {error && <p className="ops-error" role="alert">{error}</p>}{saved && <p className="ops-success" role="status">Review tersimpan.</p>}
    <footer className="ops-review-footer"><span>{locked ? "Payroll sudah final" : saved ? "Review tersimpan" : !dirty ? "Belum ada perubahan" : !validTimes ? "Periksa waktu masuk/pulang" : note.trim().length < 5 ? "Isi catatan review untuk menyimpan" : "Perubahan belum disimpan"}</span><button type="submit" className="ops-button" disabled={!canSave}>{busy ? "Menyimpan…" : "Simpan review"}</button></footer>
  </form>;
}
