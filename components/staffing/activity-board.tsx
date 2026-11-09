"use client";
import { storeZoneLabel } from "@/lib/store-timezone";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/staffing-dashboard";
import { StaffingHeader } from "./navigation";
import { Modal, ArrowIcon } from "./modal";
import { ShiftRequestDetails } from "./shift-request";
import { RequestCard } from "./requests";
import { AttendanceDetails, dateTime } from "./record-lists";
import { localTime, type StaffingStore } from "@/lib/staffing/model";
import { activityPriority, presenceLabels, presenceOf } from "@/lib/staffing/activity-view";
import { requestLabels, stateLabels, rupiah, type ActivityData, type ActivityRow, type ReviewedSession } from "@/lib/staffing/operations-model";

function ReviewBadge({ state }: { state: ActivityRow["verification_state"] }) {
  return <span className={`ops-badge ${state ? `is-${state}` : ""}`}>{state ? stateLabels[state] : "Belum ada absensi"}</span>;
}
function PresenceBadge({ row, now }: { row: ActivityRow; now: number }) {
  const state = presenceOf(row, now);
  return <span className={`ops-presence is-${state}`}><i aria-hidden="true" />{presenceLabels[state]}</span>;
}
const shortTime = (value: string | null, zone: string) => value ? localTime(value, zone).slice(11) : "—";

export function ActivityBoard({ initial, stores, canConfigure, reports = [] }: { initial: ActivityData; stores: StaffingStore[]; canConfigure: boolean; reports?: { id: string; session_id: string; reporter_name: string; created_at: string; full_name: string }[] }) {
  const [store, setStore] = useState("");
  const [day, setDay] = useState("");
  const [data, setData] = useState(initial);
  const [loadedKey, setLoadedKey] = useState("|");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [clock, setClock] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [view, setView] = useState("attendance");
  const [query, setQuery] = useState("");
  const [presence, setPresence] = useState("all");
  const [review, setReview] = useState("all");
  const [queueKind, setQueueKind] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    function openLinkedQueue() {
      const kind = ({ "#review-all": "all", "#requests": "requests", "#review-attendance": "attendance", "#review-reports": "report", "#review-shifts": "shift" } as Record<string, string>)[window.location.hash];
      if (kind) { setView("review"); setQueueKind(kind); setQuery(""); setStore(""); setDay(""); }
    }
    openLinkedQueue(); window.addEventListener("hashchange", openLinkedQueue);
    return () => window.removeEventListener("hashchange", openLinkedQueue);
  }, []);
  const filterKey = `${store}|${day}`;
  const ready = loadedKey === filterKey;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(""); setClock(Date.now());
    fetch(`/api/staffing/operations?view=activity${store ? `&store=${store}` : ""}${day ? `&day=${day}` : ""}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error); if (!controller.signal.aborted) { setData(result); setLoadedKey(`${store}|${day}`); setUpdatedAt(new Date().toISOString()); setClock(Date.now()); } })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Aktivitas belum dapat dimuat."); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [store, day, tick, initial]);
  const matches = (name: string, storeName: string, label: string) => `${name} ${storeName} ${label}`.toLocaleLowerCase("id-ID").includes(query.trim().toLocaleLowerCase("id-ID"));
  const working = data.rows.filter(row => presenceOf(row, clock) === "working");
  const pending = data.rows.filter(row => row.session_id && row.verification_state === "pending");
  const totalQueue = pending.length + data.requests.length + reports.length + (data.shift_requests?.length || 0);
  const rows = data.rows.filter(row => matches(row.full_name, row.store_name, row.label) && (presence === "all" || presenceOf(row, clock) === presence) && (review === "all" || row.verification_state === review))
    .sort((a, b) => activityPriority(a, clock) - activityPriority(b, clock) || a.starts_at.localeCompare(b.starts_at));
  const queue = [
    ...(data.shift_requests || []).map(request => ({ id: `shift:${request.id}`, kind: "shift", name: request.requester_name, store: request.store_name, title: `${request.mode === "swap" ? "Tukar shift" : "Penggantian shift"} → ${request.target_name}`, date: localTime(request.shift_snapshot.starts_at, request.time_zone).slice(0, 10), amount: request.valid ? "Pihak kedua sudah bersedia" : "Jadwal berubah / terkunci", action: "Review perubahan" })),
    ...pending.map(row => ({ id: `attendance:${row.id}`, kind: "attendance", name: row.full_name, store: row.store_name, title: row.label, date: localTime(row.starts_at, row.time_zone).slice(0, 10), amount: "Absensi perlu konfirmasi", action: "Review absensi" })),
    ...reports.map(report => ({ id: `report:${report.id}`, kind: "report", name: report.full_name, store: "", title: "Laporan rekan kerja", date: report.created_at.slice(0, 10), amount: "Perlu pemeriksaan manager", action: "Periksa laporan" })),
    ...data.requests.map(request => ({ id: `request:${request.id}`, kind: request.kind === "cash_advance" ? "cash" : "leave", name: request.full_name || "Staff", store: request.store_name || "", title: requestLabels[request.kind], date: request.start_date || request.created_at.slice(0, 10), amount: request.kind === "cash_advance" ? rupiah(request.amount) : `${request.days} hari`, action: request.status === "approved" ? "Konfirmasi pencairan" : "Review pengajuan" })),
  ].filter(row => (queueKind === "all" || row.kind === queueKind || (queueKind === "requests" && (row.kind === "cash" || row.kind === "leave"))) && matches(row.name, row.store, row.title));
  const selectedRow = selected?.startsWith("attendance:") ? data.rows.find(row => row.id === selected.slice(11)) : null;
  const selectedShiftRequest = selected?.startsWith("shift:") ? data.shift_requests?.find(request => request.id === selected.slice(6)) : null;
  const selectedRequest = selected?.startsWith("request:") ? data.requests.find(request => request.id === selected.slice(8)) : null;
  const selectedReport = selected?.startsWith("report:") ? reports.find(report => report.id === selected.slice(7)) : null;
  const session: ReviewedSession | null = selectedRow?.session_id ? { ...selectedRow, id: selectedRow.session_id, shift_id: selectedRow.id, check_in_at: selectedRow.check_in_at!, verification_state: selectedRow.verification_state! } : null;
  const selectedStore = stores.find(s => s.id === store);
  function openView(nextView: string, nextPresence = "all", nextReview = "all", nextQueue = "all") { setView(nextView); setPresence(nextPresence); setReview(nextReview); setQueueKind(nextQueue); setQuery(""); }
  return <main className="ops-shell ops-activity-shell">
    <StaffingHeader title="Activities" subtitle="Pantau kehadiran tim dan selesaikan pengajuan dari satu tempat." current="activity" canConfigure={canConfigure} />
    <div className="ops-filterbar ops-activity-scope"><label>Store<select value={store} onChange={event => { setStore(event.target.value); setSelected(null); }}><option value="">Semua store akses</option>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Tanggal aktivitas<input type="date" value={day} onChange={event => { setDay(event.target.value); setSelected(null); }} /></label><button className="ops-secondary" type="button" aria-pressed={!day} onClick={() => { setDay(""); setSelected(null); }}>Hari ini</button><p className="ops-muted">Tanggal kehadiran mengikuti timezone masing-masing store.</p><div className="ops-refresh-group"><span role="status">{busy ? "Memperbarui data…" : updatedAt ? `Diperbarui ${shortTime(updatedAt, selectedStore?.time_zone || "Asia/Jakarta")} ${selectedStore ? storeZoneLabel(selectedStore.time_zone).split(" · ")[0] : "WIB"}` : "Data awal dimuat"}</span><button type="button" className="ops-secondary" disabled={busy} onClick={() => setTick(value => value + 1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17" /></svg>Perbarui</button></div></div>
    {error && <div className="ops-error" role="alert">{error} {ready ? "Data terakhir tetap ditampilkan." : "Coba muat ulang data."} <button className="ops-link" type="button" onClick={() => setTick(value => value + 1)}>Coba lagi</button></div>}
    <div className="ops-activity-metrics" aria-label="Ringkasan aktivitas"><button type="button" aria-pressed={view === "attendance" && presence === "all" && review === "all"} onClick={() => openView("attendance")}><span>Shift terjadwal</span><strong>{ready ? data.rows.length : "—"}</strong><small>Pada tanggal terpilih <ArrowIcon /></small></button><button type="button" aria-pressed={view === "attendance" && presence === "working"} onClick={() => openView("attendance", "working")}><span>Sedang bekerja</span><strong>{ready ? working.length : "—"}</strong><small>Masuk, belum checkout <ArrowIcon /></small></button><button type="button" className="is-attention" aria-pressed={view === "review" && queueKind === "attendance"} onClick={() => openView("review", "all", "all", "attendance")}><span>Absensi perlu review</span><strong>{ready ? pending.length : "—"}</strong><small>Pada tanggal terpilih <ArrowIcon /></small></button><button type="button" className="is-attention" aria-pressed={view === "review" && queueKind === "requests"} onClick={() => openView("review", "all", "all", "requests")}><span>Pengajuan terbuka</span><strong>{ready ? data.requests.length : "—"}</strong><small>Izin, sakit, dan kasbon <ArrowIcon /></small></button></div>
    <section className="ops-panel ops-activity-list" id="requests" aria-busy={busy}>
      <div className="ops-activity-views" role="tablist" aria-label="Tampilan aktivitas"><button id="activity-tab-attendance" type="button" role="tab" aria-controls="activity-attendance" aria-selected={view === "attendance"} onClick={() => setView("attendance")}>Kehadiran <span>{ready ? data.rows.length : "—"}</span></button><button id="activity-tab-review" type="button" role="tab" aria-controls="activity-review" aria-selected={view === "review"} onClick={() => setView("review")}>Antrean Review <span>{ready ? totalQueue : "—"}</span></button></div>
      <div className="ops-activity-list-toolbar"><label>Cari staff / shift<input type="search" placeholder="Nama staff, store, atau shift" value={query} onChange={event => setQuery(event.target.value)} /></label>{view === "attendance" ? <><label>Kehadiran<select value={presence} onChange={event => setPresence(event.target.value)}><option value="all">Semua kehadiran</option>{Object.entries(presenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Verifikasi<select value={review} onChange={event => setReview(event.target.value)}><option value="all">Semua review</option><option value="pending">Menunggu review</option><option value="confirmed">Dikonfirmasi</option><option value="rejected">Ditolak</option></select></label></> : <label>Jenis antrean<select value={queueKind} onChange={event => setQueueKind(event.target.value)}><option value="all">Semua antrean</option><option value="attendance">Absensi</option><option value="requests">Semua pengajuan</option><option value="leave">Izin & sakit</option><option value="cash">Kasbon</option><option value="report">Laporan rekan kerja</option><option value="shift">Permintaan shift</option></select></label>}{(query || (view === "attendance" && (presence !== "all" || review !== "all")) || (view === "review" && queueKind !== "all")) && <button type="button" className="ops-link" onClick={() => { setQuery(""); setPresence("all"); setReview("all"); setQueueKind("all"); }}>Reset filter</button>}</div>
      {!ready ? <div className="ops-empty" role="status">{error ? "Data pada filter ini belum tersedia. Coba lagi." : "Memuat aktivitas pada filter terpilih…"}</div> : view === "attendance" ? <div role="tabpanel" id="activity-attendance" aria-labelledby="activity-tab-attendance"><div className="ops-table-wrap ops-activity-scroll"><table className="ops-table ops-record-table ops-activity-table"><thead><tr><th>Staff / store</th><th>Shift & jadwal</th><th>Masuk / pulang</th><th>Kehadiran</th><th>Verifikasi</th><th>Lokasi laporan</th><th>Detail</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={`ops-clickable-row ${row.verification_state === "pending" ? "needs-review" : ""}`} onClick={() => { if (!busy) setSelected(`attendance:${row.id}`); }}><td><strong>{row.full_name}</strong><small>{row.store_name}</small></td><td>{row.label}<small>{localTime(row.starts_at, row.time_zone).slice(0, 10)} · {shortTime(row.starts_at, row.time_zone)}–{shortTime(row.ends_at, row.time_zone)}</small></td><td>{shortTime(row.corrected_in_at || row.check_in_at, row.time_zone)} / {shortTime(row.corrected_out_at || row.check_out_at, row.time_zone)}<small>{row.time_zone}</small></td><td><PresenceBadge row={row} now={clock} /></td><td><ReviewBadge state={row.verification_state} /></td><td><span className="ops-location-state">{row.last_location ? "Lokasi tersedia" : "Belum ada lokasi"}</span>{row.last_location && <small>{shortTime(row.last_location.sent_at, row.time_zone)} · laporan terakhir</small>}</td><td><button type="button" className="ops-row-action" disabled={busy} aria-label={`Detail aktivitas ${row.full_name} ${row.label}`} onClick={event => { event.stopPropagation(); setSelected(`attendance:${row.id}`); }}>{row.verification_state === "pending" ? "Review" : "Detail"}<ArrowIcon /></button></td></tr>)}</tbody></table>{!rows.length && <div className="ops-empty"><strong>{data.rows.length ? "Tidak ada hasil yang cocok" : "Belum ada shift pada tanggal ini"}</strong><p>{data.rows.length ? "Ubah pencarian atau reset filter untuk melihat tim." : "Pilih tanggal lain atau susun jadwal dari halaman Scheduling."}</p></div>}</div><div className="ops-activity-list-footer"><span>{rows.length} dari {data.rows.length} shift · urut prioritas review</span><span>Lokasi berdasarkan laporan absensi terakhir.</span></div></div> : <div role="tabpanel" id="activity-review" aria-labelledby="activity-tab-review"><p className="ops-queue-explanation">Absensi mengikuti tanggal terpilih. Pengajuan, permintaan shift, dan laporan rekan kerja menampilkan semua yang belum selesai pada store terpilih.</p><div className="ops-table-wrap ops-activity-scroll"><table className="ops-table ops-record-table"><thead><tr><th>Staff / store</th><th>Jenis</th><th>Rincian</th><th>Tanggal</th><th>Tindakan</th></tr></thead><tbody>{queue.map(item => <tr className="ops-clickable-row needs-review" key={item.id} onClick={() => { if (!busy) setSelected(item.id); }}><td><strong>{item.name}</strong><small>{item.store}</small></td><td>{item.kind === "attendance" ? "Absensi" : item.kind === "cash" ? "Kasbon" : item.kind === "report" ? "Laporan" : item.kind === "shift" ? "Permintaan shift" : "Izin & sakit"}</td><td>{item.title}<small>{item.amount}</small></td><td>{item.date}</td><td><button type="button" className="ops-row-action" disabled={busy} onClick={event => { event.stopPropagation(); setSelected(item.id); }}>{item.action}<ArrowIcon /></button></td></tr>)}</tbody></table>{!queue.length && <div className="ops-empty"><strong>{totalQueue ? "Tidak ada antrean yang cocok" : "Semua sudah ditangani"}</strong><p>{totalQueue ? "Coba ubah pencarian atau jenis antrean." : "Tidak ada absensi atau pengajuan yang perlu ditinjau pada cakupan ini."}</p></div>}</div><div className="ops-activity-list-footer"><span>{queue.length} item perlu tindakan</span><span>Alasan pribadi tersedia pada detail pengajuan.</span></div></div>}
    </section>
    {ready && selectedRow && <Modal title={selectedRow.full_name} eyebrow={selectedRow.session_id ? "Review & detail absensi" : "Detail penugasan"} className="ops-person-modal" description={selectedRow.store_name} onClose={() => setSelected(null)} wide>
      {session ? <AttendanceDetails session={session} /> : <><dl className="ops-detail-grid"><div><dt>Shift</dt><dd>{selectedRow.label}</dd></div><div><dt>Kehadiran</dt><dd><PresenceBadge row={selectedRow} now={clock} /></dd></div><div><dt>Mulai</dt><dd>{dateTime(selectedRow.starts_at, selectedRow.time_zone)}</dd></div><div><dt>Selesai</dt><dd>{dateTime(selectedRow.ends_at, selectedRow.time_zone)}</dd></div></dl><p className="ops-muted">Belum ada absensi tercatat untuk penugasan ini.</p></>}
      {selectedRow.last_location && <div className="ops-location-detail"><h3>Lokasi laporan terakhir</h3><p>{selectedRow.last_location.latitude}, {selectedRow.last_location.longitude}</p><p className="ops-muted">Dikirim {dateTime(selectedRow.last_location.sent_at, selectedRow.time_zone)}. Titik ini merupakan bukti laporan absensi.</p><a className="ops-inline-link" href={`https://www.google.com/maps?q=${selectedRow.last_location.latitude},${selectedRow.last_location.longitude}`} target="_blank" rel="noreferrer">Buka peta eksternal <ArrowIcon /></a></div>}
      {selectedRow.can_view_profile && <Link className="ops-inline-link" href={`/staffing/staff/${selectedRow.staff_id}?tab=absensi#attendance-history`}>Buka profil staff <ArrowIcon /></Link>}
    </Modal>}
    {ready && selectedReport && <Modal title="Pemeriksaan laporan" description={selectedReport.full_name} onClose={() => setSelected(null)}><p className="ops-muted">Pelapor: {selectedReport.reporter_name} · {selectedReport.created_at.slice(0, 10)}</p><p className="ops-muted">Laporan rekan kerja perlu diperiksa sebelum mengubah absensi.</p><ActionForm action="resolve_report" label="Simpan hasil pemeriksaan" onResult={() => setSelected(null)}><input type="hidden" name="report_id" value={selectedReport.id} /><label>Hasil pemeriksaan<textarea name="reason" required minLength={5} maxLength={1000} rows={3} /></label></ActionForm></Modal>}
    {ready && selectedShiftRequest && <Modal title="Review perubahan shift" description={`${selectedShiftRequest.requester_name} · ${selectedShiftRequest.store_name}`} onClose={() => setSelected(null)}><ShiftRequestDetails request={selectedShiftRequest} onSaved={() => { setSelected(null); setTick(value => value + 1); }} /></Modal>}
    {ready && selectedRequest && <Modal title="Review pengajuan" description={`${selectedRequest.full_name} · ${selectedRequest.store_name}`} onClose={() => setSelected(null)}><RequestCard request={selectedRequest} onSaved={() => setTick(value => value + 1)} /></Modal>}
  </main>;
}
