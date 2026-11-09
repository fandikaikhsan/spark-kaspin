"use client";
import { useState } from "react";
import { TimeChip } from "./time-chip";
import { Modal } from "./modal";
import { AttendanceChips } from "./attendance-chips";
import { AttendanceControls } from "./attendance-controls";
import { RequestCard, RequestForm, RequestStatusBadge } from "./requests";
import { OperationForm } from "./operation-form";
import { attendanceMatches } from "@/lib/staffing/activity-view";
import { localTime } from "@/lib/staffing/model";
import { requestLabels, requestNeedsAction, stateLabels, rupiah, type ReviewedSession, type StaffDetail, type StaffRequest } from "@/lib/staffing/operations-model";

export const dateTime = (value: string, zone: string) => localTime(value, zone).replace("T", " ");
const clock = (value: string | null, zone: string) => value ? localTime(value, zone).slice(11) : "—";
function lateMinutes(session: ReviewedSession) {
  return Math.max(0, Math.ceil((Date.parse(session.corrected_in_at || session.check_in_at) - Date.parse(session.starts_at)) / 60000));
}

export function AttendanceList({ sessions, staffName }: { sessions: ReviewedSession[]; staffName: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [review, setReview] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rows = sessions.filter(s => attendanceMatches(s, { query, review, from, to }));
  const filtered = !!query || review !== "all" || !!from || !!to;
  const session = sessions.find(s => s.id === selected);
  return <section className="ops-panel" id="attendance-history"><div className="ops-section-heading"><div><h2>Riwayat absensi</h2><p className="ops-muted">Klik baris untuk melihat bukti, konfirmasi, atau koreksi waktu.</p></div><span className="ops-badge" role="status">{rows.length} / {sessions.length} sesi</span></div>
    <div className="ops-history-filters"><label>Cari absensi<input type="search" placeholder="Shift, store, atau tanggal" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Status review<select value={review} onChange={event => setReview(event.target.value)}><option value="all">Semua status</option><option value="pending">Menunggu review</option><option value="confirmed">Dikonfirmasi</option><option value="rejected">Ditolak</option></select></label><label>Dari tanggal<input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></label><label>Sampai tanggal<input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label>{filtered && <button type="button" className="ops-link" onClick={() => { setQuery(""); setReview("all"); setFrom(""); setTo(""); }}>Reset filter</button>}</div>
    <div className="ops-table-wrap ops-attendance-scroll" role="region" aria-label="Daftar riwayat absensi, dapat digulir" tabIndex={0}><table className="ops-table ops-record-table"><thead><tr><th>Tanggal / store</th><th>Shift</th><th>Masuk</th><th>Pulang</th><th>Durasi aktual</th><th>Keterlambatan</th><th>Review</th><th>Detail</th></tr></thead><tbody>
      {rows.map(s => {
        const entered = s.corrected_in_at || s.check_in_at;
        const exited = s.corrected_out_at || s.check_out_at;
        const late = lateMinutes(s);
        return <tr key={s.id} className={`ops-clickable-row${s.verification_state === "pending" ? " needs-review" : ""}`} onClick={() => setSelected(s.id)}><td><strong>{localTime(s.starts_at, s.time_zone).slice(0, 10)}</strong><small>{s.store_name}</small></td><td>{s.label}<small>{clock(s.starts_at, s.time_zone)}–{clock(s.ends_at, s.time_zone)}</small><AttendanceChips session={s} /></td><td><TimeChip value={entered} zone={s.time_zone} clockOnly />{s.corrected_in_at && <small>Dikoreksi</small>}</td><td>{exited ? <TimeChip value={exited} zone={s.time_zone} clockOnly /> : "—"}<small>{exited && localTime(exited, s.time_zone).slice(0, 10) !== localTime(entered, s.time_zone).slice(0, 10) ? localTime(exited, s.time_zone).slice(0, 10) : !exited ? "Belum checkout" : ""}</small></td><td>{exited ? `${((Date.parse(exited) - Date.parse(entered)) / 3600000).toFixed(2)} jam` : "Berjalan"}</td><td><span className={`ops-badge ${late ? "is-pending" : "is-confirmed"}`}>{late ? `${late} menit` : "Tepat waktu"}</span></td><td><span className={`ops-badge is-${s.verification_state}`}>{stateLabels[s.verification_state]}</span></td><td><button type="button" className="ops-link" aria-label={`Detail absensi ${s.label} ${localTime(s.starts_at, s.time_zone).slice(0, 10)}`} onClick={e => { e.stopPropagation(); setSelected(s.id); }}>Lihat detail</button></td></tr>;
      })}
    </tbody></table>{!rows.length && <p className="ops-empty">{sessions.length ? "Tidak ada absensi yang cocok dengan filter." : "Belum ada absensi."}</p>}</div>
    {session && <Modal title={staffName} eyebrow="Review & detail absensi" className="ops-person-modal" description={`${session.store_name} · ${session.label}`} onClose={() => setSelected(null)} wide>
      <AttendanceDetails session={session} />
    </Modal>}
  </section>;
}

export function AttendanceDetails({ session }: { session: ReviewedSession }) {
  return <AttendanceControls session={session} />;
}

export function RequestTable({ requests, onSelect }: { requests: StaffRequest[]; onSelect: (id: string) => void }) {
  return <div className="ops-table-wrap"><table className="ops-table ops-record-table"><thead><tr><th>Jenis</th><th>Periode / tanggal dibuat</th><th>Jumlah</th><th>Status</th><th>Detail</th></tr></thead><tbody>
    {requests.map(r => <tr key={r.id} className={`ops-clickable-row${requestNeedsAction(r) ? " needs-review" : ""}`} onClick={() => onSelect(r.id)}><td><strong>{requestLabels[r.kind]}</strong></td><td>{r.kind === "cash_advance" ? r.created_at.slice(0, 10) : <>{r.start_date}<small>s.d. {r.end_date}</small></>}</td><td>{r.kind === "cash_advance" ? rupiah(r.amount) : `${r.days} hari`}</td><td><RequestStatusBadge request={r} /></td><td><button type="button" className="ops-link" aria-label={`Detail ${requestLabels[r.kind]} ${r.start_date || r.created_at.slice(0, 10)}`} onClick={e => { e.stopPropagation(); onSelect(r.id); }}>Lihat detail</button></td></tr>)}
  </tbody></table>{!requests.length && <p className="ops-empty">Belum ada pengajuan.</p>}</div>;
}

export function LeaveList({ detail, today }: { detail: StaffDetail; today: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [balance, setBalance] = useState(false);
  const requests = detail.requests.filter(r => r.kind !== "cash_advance");
  const request = requests.find(r => r.id === selected);
  return <section className="ops-panel"><div className="ops-section-heading"><div><h2>Izin & sakit</h2><p className="ops-muted">Saldo izin berbayar: <strong>{detail.money.leave_balance ?? "Belum dicatat"}{detail.money.leave_balance !== null ? " hari" : ""}</strong></p></div><div className="ops-action-group"><button type="button" className="ops-secondary" onClick={() => setBalance(true)}>Penyesuaian</button><button type="button" className="ops-button" onClick={() => setCreate(true)}>+ Buat izin / sakit</button></div></div>
    <RequestTable requests={requests} onSelect={setSelected} />
    {request && <Modal title={`Detail ${requestLabels[request.kind].toLowerCase()}`} description={`${detail.profile.full_name} · ${detail.store.name}`} onClose={() => setSelected(null)}><RequestCard request={request} /></Modal>}
    {create && <Modal title="Buat izin / sakit" description={`Catat pengajuan untuk ${detail.profile.full_name}. Persetujuan dilakukan setelah pengajuan tersimpan.`} onClose={() => setCreate(false)}><RequestForm staffId={detail.profile.id} today={today} available={detail.money.available} onSaved={() => setCreate(false)} /></Modal>}
    {balance && <Modal title="Penyesuaian saldo izin" description="Saldo hanya berubah melalui catatan penyesuaian atau izin berbayar yang disetujui." onClose={() => setBalance(false)}>
      <p>Saldo tersedia: <strong>{detail.money.leave_balance ?? "Belum dicatat"}{detail.money.leave_balance !== null ? " hari" : ""}</strong></p>
      <OperationForm action="leave_adjustment" data={{ staff_id: detail.profile.id }} label="Simpan penyesuaian saldo"><label>Perubahan saldo (hari)<input name="days" type="number" step={0.5} min={-1000} max={1000} required placeholder="Contoh: 2 untuk tambah, -1 untuk kurangi" /><small>Isi 2 untuk menambah 2 hari atau -1 untuk mengurangi 1 hari.</small></label><label>Alasan penyesuaian<input name="reason" required minLength={5} /></label></OperationForm>
      <h3>Riwayat saldo</h3>{detail.leave_entries.map(entry => <div className="ops-ledger" key={entry.id}><strong>{Number(entry.days) > 0 ? "+" : ""}{entry.days} hari</strong><span>{entry.reason}</span><small>{dateTime(entry.created_at, detail.store.time_zone)}</small></div>)}
    </Modal>}
  </section>;
}
