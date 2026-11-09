"use client";
import { storeZoneLabel } from "@/lib/store-timezone";
import { ArrowIcon, Modal } from "./modal";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type FormEvent } from "react";
import { localTime, storeInstant, type StaffingStore, type Staff } from "@/lib/staffing/model";
import { schedulePaint, addDays, allocation, clippedMinutes, conflictFor, DAY_MINUTES, fillToTarget, fragments, hoursLabel, mondayOf, moveShift, plannerDirty, shiftRange, SNAP_MINUTES, timeLabel, validPlacement, WEEK_MINUTES, type PlanShift, type ScheduleWeek } from "@/lib/staffing/schedule";

const DAY_NAMES = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const FULL_DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
const PIXELS_PER_MINUTE = 0.8;
const CARD_TYPE = "application/x-spark-staff";
const COLORS = ["#2764b7", "#14796d", "#945ac0", "#a96213", "#b04b79", "#56772b"];
function colorFor(id: string) { return COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length]; }
function initialDraft(data: ScheduleWeek): PlanShift[] { return data.shifts.map((shift) => ({ ...shift, persisted: true })); }
const dates = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" });
function dateLabel(date: string) { return dates.format(new Date(`${date}T00:00:00Z`)); }

type Gesture = { id: string; pointerId: number; mode: "move" | "start" | "end"; original: PlanShift; startX: number; startY: number; fragmentDay: number; scrollTop: number; moved: boolean };

function ShiftEditor({ shift, week, zone, staff, onSave, onRemove }: { staff: Staff[]; shift: PlanShift; week: string; zone: string; onSave: (shift: PlanShift) => void; onRemove: () => void }) {
  const [label, setLabel] = useState(shift.label);
  const [staffId, setStaffId] = useState(shift.staff_id);
  const [changingStaff, setChangingStaff] = useState(false);
  const [day, setDay] = useState(localTime(shift.starts_at, zone).slice(0, 10));
  const [start, setStart] = useState(timeLabel(shift.starts_at, zone));
  const [end, setEnd] = useState(timeLabel(shift.ends_at, zone));
  useEffect(() => { setStaffId(shift.staff_id); setLabel(shift.label); setDay(localTime(shift.starts_at, zone).slice(0, 10)); setStart(timeLabel(shift.starts_at, zone)); setEnd(timeLabel(shift.ends_at, zone)); }, [shift.id, shift.staff_id, shift.label, shift.starts_at, shift.ends_at, zone]);
  const locked = shift.locked || !shift.editable;
  function submit(event: FormEvent) {
    event.preventDefault();
    try { onSave({ ...shift, staff_id: staffId, full_name: staff.find(person => person.id === staffId)?.full_name || shift.full_name, label: label.trim(), starts_at: storeInstant(`${day}T${start}`, zone), ends_at: storeInstant(`${addDays(day, end <= start ? 1 : 0)}T${end}`, zone) }); }
    catch { /* Native required controls prevent incomplete values. */ }
  }
  return <section className="planner-selection" aria-labelledby="selected-shift-title">
    <p className="planner-kicker">Shift terpilih</p><h3 id="selected-shift-title">{shift.full_name}</h3>
    {locked ? <p className="planner-muted">{shift.locked ? "Shift ini sudah memiliki proses atau catatan absensi. Gunakan koreksi absensi bila diperlukan." : "Penugasan ini berasal dari minggu sebelumnya atau staff di luar cakupan pengelolaanmu."}</p> : <form onSubmit={submit} className="planner-fields">
      <button className="planner-secondary" type="button" onClick={() => setChangingStaff(value => !value)}>Tukar / ganti staff</button>
      {changingStaff && <label>Staff pengganti<select value={staffId} onChange={event => setStaffId(event.target.value)}>{staff.map(person => <option key={person.id} value={person.id}>{person.full_name}{person.id === shift.staff_id ? " (saat ini)" : ""}</option>)}</select><small>Penugasan dipindahkan ke staff terpilih saat Commit. Penugasan staff lain tidak ikut ditukar.</small></label>}
      <label>Nama shift<input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} /></label>
      <label>Hari shift<select value={day} onChange={(e) => setDay(e.target.value)}>{DAY_NAMES.map((name, i) => <option key={name} value={addDays(week, i)}>{name}, {dateLabel(addDays(week, i))}</option>)}</select></label>
      <div className="planner-time-fields"><label>Mulai<input type="time" step={60} value={start} onChange={(e) => setStart(e.target.value)} required /></label><label>Selesai<input type="time" step={60} value={end} onChange={(e) => setEnd(e.target.value)} required /></label></div>
      <p className="planner-muted">Jika selesai ≤ mulai, shift berakhir hari berikutnya.</p>
      <button className="planner-secondary" type="submit">Terapkan ke draft</button>
      <button className="planner-delete" type="button" onClick={onRemove}>Hapus dari draft</button>
    </form>}
  </section>;
}

export function WeeklyPlanner({ stores, initialStore, initialWeek }: { stores: StaffingStore[]; canConfigure: boolean; initialStore?: string; initialWeek?: string }) {
  const [storeId, setStoreId] = useState(initialStore || stores[0]?.id || "");
  const zone = stores.find((s) => s.id === storeId)?.time_zone || "Asia/Jakarta";
  const [week, setWeek] = useState(() => initialWeek || mondayOf(localTime(new Date().toISOString(), stores.find(s=>s.id===initialStore)?.time_zone || stores[0]?.time_zone || "Asia/Jakarta").slice(0, 10)));
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<ScheduleWeek | null>(null);
  const [draft, setDraft] = useState<PlanShift[]>([]);
  const draftRef = useRef<PlanShift[]>([]);
  const baseline = useRef<PlanShift[]>([]);
  const [history, setHistory] = useState<PlanShift[][]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [allRegion, setAllRegion] = useState(false);
  const [wideCards, setWideCards] = useState(true);
  const [targetHours, setTargetHours] = useState(40);
  const [durationHours, setDurationHours] = useState(8);
  const [defaultStart, setDefaultStart] = useState("08:00");
  const [randomOpen, setRandomOpen] = useState(false);
  const [randomDays, setRandomDays] = useState([0, 1, 2, 3, 4, 5]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlanShift | null>(null);
  const [draggingStaff, setDraggingStaff] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const previewRef = useRef<PlanShift | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const dirty = plannerDirty(draft, baseline.current);
  const ready = data?.store.id === storeId && data.week_start === week;
  const busy = ready ? data.busy : [];
  const shown = useMemo(() => preview ? draft.map((shift) => shift.id === preview.id ? preview : shift) : draft, [draft, preview]);
  const pieces = useMemo(() => fragments(shown, week, zone), [shown, week, zone]);
  const roster = ready ? data.staff.filter((s) => (allRegion || s.home_store_id === storeId) && `${s.full_name} ${s.code}`.toLowerCase().includes(query.toLowerCase())) : [];
  const planned = [...shown, ...busy];
  const totalMinutes = shown.reduce((sum, shift) => sum + clippedMinutes(shift, week, zone), 0);
  const remaining = roster.reduce((sum, s) => sum + Math.max(0, targetHours * 60 - allocation(s.id, planned, week, zone).minutes), 0);
  const conflicts = shown.filter((shift) => conflictFor(shift, shown, busy));
  const selectedShift = shown.find((s) => s.id === selected);
  const dayWidths = DAY_NAMES.map((_, day) => wideCards ? Math.max(132, ...pieces.filter((p) => p.day === day).map((p) => p.lanes * 86)) : 132);
  const calendarStyle = { "--planner-columns": `48px ${dayWidths.map((width) => `minmax(${width}px, 1fr)`).join(" ")}`, "--planner-min-width": `${48 + dayWidths.reduce((sum, width) => sum + width, 0)}px` } as CSSProperties;
  const today = localTime(new Date().toISOString(), zone).slice(0, 10);

  useEffect(() => {
    if (!storeId) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setNotice("");
    fetch(`/api/staffing/schedule?store=${storeId}&week=${week}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) { window.location.assign("/login?next=/staffing/schedule"); throw new Error("Silakan login kembali."); }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Jadwal tidak dapat dimuat.");
        if (controller.signal.aborted) return;
        const next = initialDraft(payload);
        setData(payload); setDraft(next); draftRef.current = next; baseline.current = next;
        setHistory([]); setSelected(null); setPreview(null);
        requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = 6 * 60 * PIXELS_PER_MINUTE; });
      }).catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [storeId, week, reload]);
  useEffect(() => {
    if (!dirty) return;
    const listener = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const onNavigate = (event: Event) => {
      if (!window.confirm("Ada perubahan draft yang belum di-commit. Buang perubahan dan lanjutkan?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    window.addEventListener("spark:navigate", onNavigate);
    return () => { window.removeEventListener("beforeunload", listener); window.removeEventListener("spark:navigate", onNavigate); };
  }, [dirty]);

  function changeDraft(next: PlanShift[]) {
    setHistory((items) => [...items.slice(-24), draftRef.current]);
    draftRef.current = next; setDraft(next); setError(""); setNotice("");
  }
  function saveCandidate(candidate: PlanShift) {
    const original = baseline.current.find(shift => shift.id === candidate.id);
    if (original && original.staff_id !== candidate.staff_id) candidate = { ...candidate, replaces_staff_id: original.staff_id, replaced_staff_name: original.full_name };
    else if (original) candidate = { ...candidate, replaces_staff_id: original.replaces_staff_id, replaced_staff_name: original.replaced_staff_name };
    if (!candidate.label.trim()) { setError("Nama shift wajib diisi."); return; }
    const problem = validPlacement(candidate, draftRef.current, busy, week, zone);
    if (problem) { setError(problem); return; }
    const exists = draftRef.current.some((s) => s.id === candidate.id);
    changeDraft(exists ? draftRef.current.map((s) => s.id === candidate.id ? candidate : s) : [...draftRef.current, candidate]);
    setSelected(candidate.id);
  }
  function discardAllowed() { return !dirty || window.confirm("Ada perubahan draft yang belum di-commit. Buang perubahan dan lanjutkan?"); }
  function changeWeek(next: string) { if (next === week) return; if (discardAllowed()) { setData(null); setWeek(next); } }
  function addStaff(person: Staff, day: number, startMinute: number) {
    const from = day * DAY_MINUTES + startMinute;
    const candidate = moveShift({ id: `draft-${crypto.randomUUID()}`, staff_id: person.id, full_name: person.full_name, store_id: storeId, label: "Shift", starts_at: "", ends_at: "", editable: true, locked: false, persisted: false }, from, from + durationHours * 60, week, zone);
    saveCandidate(candidate);
  }
  function pointerStart(event: ReactPointerEvent<HTMLElement>, shift: PlanShift, fragmentDay: number, mode: Gesture["mode"]) {
    if (saving || shift.locked || !shift.editable || event.button !== 0) { setSelected(shift.id); return; }
    event.preventDefault(); event.stopPropagation();
    scroller.current?.setPointerCapture(event.pointerId);
    previewRef.current = null;
    gesture.current = { id: shift.id, pointerId: event.pointerId, mode, original: shift, startX: event.clientX, startY: event.clientY, fragmentDay, scrollTop: scroller.current?.scrollTop || 0, moved: false };
    setSelected(shift.id);
  }
  function pointerMove(event: ReactPointerEvent<HTMLElement>) {
    const action = gesture.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - action.startX) + Math.abs(event.clientY - action.startY) < 4 && !action.moved) return;
    action.moved = true;
    const scrollDelta = (scroller.current?.scrollTop || 0) - action.scrollTop;
    const delta = Math.round((event.clientY - action.startY + scrollDelta) / PIXELS_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES;
    const [originalStart, originalEnd] = shiftRange(action.original, week, zone);
    let from = originalStart; let to = originalEnd;
    if (action.mode === "move") {
      const day = columns.current.findIndex((column) => { const rect = column?.getBoundingClientRect(); return rect && event.clientX >= rect.left && event.clientX < rect.right; });
      from = originalStart + delta + (day < 0 ? 0 : day - action.fragmentDay) * DAY_MINUTES;
      to = from + originalEnd - originalStart;
    } else if (action.mode === "start") from = Math.min(originalEnd - SNAP_MINUTES, originalStart + delta);
    else to = Math.max(originalStart + SNAP_MINUTES, originalEnd + delta);
    const candidate = moveShift(action.original, from, to, week, zone);
    previewRef.current = candidate; setPreview(candidate);
  }
  function pointerEnd(event: ReactPointerEvent<HTMLElement>) {
    const action = gesture.current;
    if (!action || action.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (action.moved && previewRef.current) saveCandidate(previewRef.current);
    previewRef.current = null; setPreview(null);
  }
  function randomFill() {
    if (!ready) return;
    const [hour, minute] = defaultStart.split(":").map(Number);
    const next = fillToTarget(draft, data.busy, roster, storeId, week, zone, { targetMinutes: targetHours * 60, duration: durationHours * 60, startMinute: hour * 60 + minute, days: randomDays });
    const added = next.length - draft.length;
    if (!added) { setNotice("Tidak ada slot tambahan yang memenuhi pengaturan. Periksa hari, target, dan penugasan yang sudah ada."); return; }
    changeDraft(next);
    const left = roster.reduce((sum, s) => sum + Math.max(0, targetHours * 60 - allocation(s.id, [...next, ...data.busy], week, zone).minutes), 0);
    setNotice(`${added} shift ditambahkan ke draft.${left > 0 ? ` Masih ada ${hoursLabel(left)} jam target yang belum terisi; slot tersedia tidak mencukupi.` : " Target daftar staff sudah terisi."}`);
  }
  async function commit() {
    if (!ready || !dirty || conflicts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/staffing/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ store_id: storeId, week_start: week, version: data.version, shifts: draft.filter((shift) => { const [start] = shiftRange(shift, week, zone); return start >= 0 && start < WEEK_MINUTES; }).map((s) => ({ id: s.persisted ? s.id : null, staff_id: s.staff_id, label: s.label, starts_at: s.starts_at, ends_at: s.ends_at })) }) });
      if (response.status === 401) { window.location.assign("/login?next=/staffing/schedule"); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Commit gagal. Draft belum disimpan.");
      const next = initialDraft(payload); setData(payload); baseline.current = next; draftRef.current = next; setDraft(next); setHistory([]); setSelected(null);
      setNotice("Commit berhasil. Jadwal minggu ini sudah tersimpan dan tersedia untuk absensi.");
    } catch (err) { setError(err instanceof Error ? err.message : "Commit gagal. Draft tetap tersedia."); }
    finally { setSaving(false); }
  }

  return <main className="planner-shell">
    <h1 className="ops-sr-only">Editor jadwal</h1>
    <section className="planner-toolbar" aria-label="Pengaturan minggu">
      <nav className="planner-toolbar-nav" aria-label="Navigasi jadwal"><Link className="planner-secondary" href="/staffing/schedule" onClick={(e)=>{if(!discardAllowed())e.preventDefault();}}>Jadwal committed</Link><Link className="planner-secondary" href="/staffing" onClick={(e)=>{if(!discardAllowed())e.preventDefault();}}>Overview</Link></nav>
      <label>Store<select value={storeId} disabled={saving || loading} onChange={(event) => { if (discardAllowed()) { setData(null); setStoreId(event.target.value); } }}>{!stores.length && <option value="">Belum ada store ber-region</option>}{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <div className="planner-week-nav"><button type="button" aria-label="Minggu sebelumnya" disabled={saving || loading} onClick={() => changeWeek(addDays(week, -7))}><ArrowIcon direction="left" /></button><label>Minggu mulai<input type="date" value={week} disabled={saving || loading} onChange={(event) => { if (event.target.value) changeWeek(mondayOf(event.target.value)); }} /></label><button type="button" aria-label="Minggu berikutnya" disabled={saving || loading} onClick={() => changeWeek(addDays(week, 7))}><ArrowIcon /></button><button type="button" disabled={saving || loading} onClick={() => changeWeek(mondayOf(today))}>Minggu ini</button></div>
      <span className="planner-timezone">{storeZoneLabel(zone)}</span>
      <div className="planner-save-actions"><span className={`planner-draft-status ${dirty ? "is-dirty" : ""}`}>{!ready ? "Belum dimuat" : dirty ? "● Draft belum disimpan" : "✓ Tersimpan"}</span><button type="button" className="planner-secondary" disabled={!history.length || saving || loading} onClick={() => { const previous = history[history.length - 1]; setHistory(history.slice(0, -1)); setDraft(previous); draftRef.current = previous; setPreview(null); }}>Undo</button><button type="button" className="planner-secondary" disabled={saving || loading || !storeId} onClick={() => { if (discardAllowed()) setReload((n) => n + 1); }}>Muat ulang</button><button className="planner-primary" type="button" onClick={commit} disabled={!dirty || !ready || saving || loading || !!conflicts.length || !!preview}>{saving ? "Menyimpan…" : "Commit jadwal"}</button></div>
    </section>
    {error && <p className="planner-alert is-error" role="alert">{error}</p>}{notice && <p className="planner-alert" role="status">{notice}</p>}
    {loading && <p className="planner-alert" role="status">Memuat jadwal minggu ini…</p>}
    {!stores.length && <p className="planner-alert">Hubungkan store ke region melalui halaman Staffing terlebih dahulu.</p>}
    {ready && !loading && <div className={`planner-layout ${saving ? "is-saving" : ""}`}>
      <aside className="planner-roster" aria-label="Daftar staff">
        <div className="planner-section-heading"><h2>Staff</h2><span>{roster.length} orang</span></div>
        <p className="planner-muted">Drag kartu ke hari dan jam yang diinginkan.</p>
        <label className="planner-search">Cari staff<input placeholder="Nama atau kode staff" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <label className="planner-checkbox"><input type="checkbox" checked={allRegion} onChange={(e) => setAllRegion(e.target.checked)} />Staff dari seluruh region akses</label>
        <div className="planner-roster-list">
          {roster.map((person) => {
            const stats = allocation(person.id, planned, week, zone);
            const outside = allocation(person.id, busy, week, zone).minutes;
            return <article className={`planner-person ${draggingStaff === person.id ? "is-dragging" : ""}`} key={person.id} draggable={!saving} onDragStart={(e) => { e.dataTransfer.setData(CARD_TYPE, person.id); e.dataTransfer.effectAllowed = "copy"; setDraggingStaff(person.id); }} onDragEnd={() => setDraggingStaff(null)} style={{ "--person-color": colorFor(person.id) } as CSSProperties}>
              <div className="planner-person-heading"><span className="planner-avatar">{person.full_name.replace(/\([^)]*\)/g, "").trim().split(/\s+/).map((n) => n[0]).slice(0, 2).join("")}</span><div><strong>{person.full_name}</strong><small>{person.code}</small></div><span aria-hidden="true">⠿</span></div>
              <div className="planner-person-hours"><strong>{hoursLabel(stats.minutes)} <span>/ {targetHours} jam</span></strong><span>{stats.days.length} hari</span></div>
              <div className="planner-progress"><span style={{ width: `${Math.min(100, stats.minutes / Math.max(1, targetHours * 60) * 100)}%` }} /></div>
              <div className="planner-days-chips">{stats.days.length ? stats.days.map((day) => <span key={day}>{DAY_NAMES[day]}</span>) : <small>Belum diplot minggu ini</small>}</div>
              {outside > 0 && <small className="planner-muted">Termasuk {hoursLabel(outside)} jam di penugasan lain.</small>}
              <button type="button" className="planner-add" disabled={saving || !defaultStart} onClick={() => { const [h, m] = defaultStart.split(":").map(Number); const nextDay = Array.from({ length: 7 }, (_, i) => i).find((day) => !stats.days.includes(day)) ?? 0; addStaff(person, nextDay, h * 60 + m); }}>+ Tambah shift</button>
            </article>;
          })}
          {!roster.length && <p className="planner-muted">Tidak ada staff pada daftar ini. Tambahkan staff atau ubah filter.</p>}
        </div>
        <Link className="planner-manage-link" href="/staffing/staff" onClick={(e) => { if (!discardAllowed()) e.preventDefault(); }}>Kelola data staff ↗</Link>
      </aside>
      <section className="planner-timetable" aria-label="Timetable mingguan">
        <div className="planner-calendar-heading"><div><h2>{dateLabel(week)} – {dateLabel(addDays(week, 6))}</h2><p>Snap 30 menit · geser kartu untuk pindah · tarik tepi atas/bawah untuk ubah jam</p></div><div className="planner-view-controls"><span>{shown.length} shift</span><div role="group" aria-label="Tampilan kartu"><button type="button" aria-pressed={wideCards} onClick={() => setWideCards(true)}>Lebar</button><button type="button" aria-pressed={!wideCards} onClick={() => setWideCards(false)}>Ringkas</button></div></div></div>
        <div className="planner-calendar-scroll" ref={scroller} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={() => { gesture.current = null; previewRef.current = null; setPreview(null); }} onLostPointerCapture={() => { gesture.current = null; previewRef.current = null; setPreview(null); }}>
          <div className="planner-calendar" style={calendarStyle}>
            <div className="planner-day-headers"><span className="planner-axis-title">Jam</span>{DAY_NAMES.map((day, index) => <div className={addDays(week, index) === today ? "is-today" : ""} key={day}><strong>{day}</strong><span>{dateLabel(addDays(week, index))}</span></div>)}</div>
            <div className="planner-timebody" style={{ height: DAY_MINUTES * PIXELS_PER_MINUTE }}>
              <div className="planner-time-axis">{Array.from({ length: 24 }, (_, hour) => <span style={{ top: hour * 60 * PIXELS_PER_MINUTE }} key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div>
              {DAY_NAMES.map((dayName, day) => <div className={`planner-day-column ${draggingStaff ? "accepts-drop" : ""}`} key={dayName} data-day={day} aria-label={`${FULL_DAYS[day]}, ${addDays(week, day)}`} ref={(el) => { columns.current[day] = el; }} onDragOver={(e) => { if (e.dataTransfer.types.includes(CARD_TYPE) && !saving) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }} onDrop={(e) => {
                e.preventDefault(); setDraggingStaff(null); if (saving) return;
                const person = data.staff.find((s) => s.id === e.dataTransfer.getData(CARD_TYPE));
                if (!person) return;
                const minute = Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, Math.round((e.clientY - e.currentTarget.getBoundingClientRect().top) / PIXELS_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES));
                addStaff(person, day, minute);
              }}>
                {pieces.filter((piece) => piece.day === day).map((piece) => {
                  const shift = piece.shift;
                  const paint = schedulePaint(piece.start, piece.end);
                  const locked = shift.locked || !shift.editable;
                  const invalid = !!preview && preview.id === shift.id && !!validPlacement(preview, draft, busy, week, zone);
                  return <div role="button" tabIndex={0} aria-label={`${shift.full_name}, ${FULL_DAYS[day]}, ${timeLabel(shift.starts_at, zone)} sampai ${timeLabel(shift.ends_at, zone)}${locked ? ", terkunci" : ""}`} aria-pressed={selected === shift.id} key={`${shift.id}-${day}`} className={`planner-shift ${selected === shift.id ? "is-selected" : ""} ${locked ? "is-locked" : ""} ${invalid ? "is-invalid" : ""} ${!shift.persisted ? "is-new" : ""}`} style={{ top: piece.start * PIXELS_PER_MINUTE + 1, height: Math.max(19, (piece.end - piece.start) * PIXELS_PER_MINUTE - 2), left: `calc(${piece.lane / piece.lanes * 100}% + 3px)`, width: `calc(${100 / piece.lanes}% - 6px)`, "--person-color": paint.edge, "--shift-fill": paint.fill } as CSSProperties} title={`${shift.full_name}\n${shift.label}\n${localTime(shift.starts_at, zone)} – ${localTime(shift.ends_at, zone)}\n${locked ? "Terkunci" : "Drag untuk pindah, atau pilih untuk mengedit"}`} onPointerDown={(e) => pointerStart(e, shift, day, "move")} onClick={() => setSelected(shift.id)} onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(shift.id); }
                    if (locked || saving) return;
                    const delta = ({ ArrowUp: -30, ArrowDown: 30, ArrowLeft: -1440, ArrowRight: 1440 } as Record<string, number>)[e.key];
                    if (delta) { e.preventDefault(); const [a, b] = shiftRange(shift, week, zone); saveCandidate(moveShift(shift, a + delta, b + delta, week, zone)); }
                    if (e.key === "Delete") { e.preventDefault(); changeDraft(draft.filter((s) => s.id !== shift.id)); setSelected(null); }
                  }}>
                    {!locked && !piece.continued && <button type="button" className="planner-resize is-top" aria-label={`Ubah jam mulai ${shift.full_name}`} onPointerDown={(e) => pointerStart(e, shift, day, "start")} onClick={(e) => e.stopPropagation()} />}
                    <div className="planner-shift-caption"><strong>{piece.continued ? "↳ " : ""}{shift.full_name}</strong><span>{timeLabel(shift.starts_at, zone)}–{timeLabel(shift.ends_at, zone)}{piece.continues ? " ↪" : ""}</span><small>{locked ? "Terkunci" : shift.label}</small>{shift.replaced_staff_name && <small>Menggantikan {shift.replaced_staff_name}</small>}</div>
                    {!locked && !piece.continues && <button type="button" className="planner-resize is-bottom" aria-label={`Ubah jam selesai ${shift.full_name}`} onPointerDown={(e) => pointerStart(e, shift, day, "end")} onClick={(e) => e.stopPropagation()} />}
                  </div>;
                })}
              </div>)}
            </div>
          </div>
        </div>
        <p className="planner-calendar-note">Geser horizontal untuk hari lain, atau pilih Ringkas untuk melihat seluruh minggu. Jam terjadwal termasuk istirahat. Kartu terkunci memiliki catatan absensi atau berada di luar cakupan edit. Pilih kartu untuk mengatur jam dengan form; tombol panah juga dapat memindahkan kartu.</p>
      </section>
      <aside className="planner-summary" aria-label="Ringkasan mingguan">
        <div className="planner-summary-scroll">
        <p className="planner-kicker">Ringkasan store</p><div className="planner-total"><strong>{hoursLabel(totalMinutes)}</strong><span>jam minggu ini</span></div>
        <div className="planner-summary-counts"><span><b>{shown.length}</b> shift</span><span><b>{new Set(shown.map((s) => s.staff_id)).size}</b> staff</span></div>
        {selectedShift && <ShiftEditor staff={data.staff} shift={selectedShift} week={week} zone={zone} onSave={saveCandidate} onRemove={() => { changeDraft(draft.filter((s) => s.id !== selectedShift.id)); setSelected(null); }} />}
        <div className="planner-daily-summary">{DAY_NAMES.map((name, day) => {
          const dayPieces = pieces.filter((p) => p.day === day);
          const mins = dayPieces.reduce((sum, p) => sum + p.end - p.start, 0);
          return <div key={name}><span>{name}</span><div className="planner-daily-bar"><span style={{ width: `${Math.min(100, mins / Math.max(1, ...DAY_NAMES.map((_, i) => pieces.filter((p) => p.day === i).reduce((s, p) => s + p.end - p.start, 0))) * 100)}%` }} /></div><strong>{hoursLabel(mins)}j</strong></div>;
        })}</div>
        {!!conflicts.length && <p className="planner-alert is-error">Ada {conflicts.length} penugasan bertabrakan. Selesaikan sebelum commit.</p>}
        </div>
        <div className="planner-fill-action"><p className="planner-remaining"><strong>{hoursLabel(remaining)} jam</strong> target daftar belum terisi</p><button type="button" className="planner-random-button" disabled={saving || !roster.length} onClick={() => setRandomOpen(true)}>Isi sisa target <ArrowIcon /></button></div>
      </aside>
    </div>}
    {randomOpen && ready && !loading && <Modal title="Isi sisa target" description={`${stores.find(store => store.id === storeId)?.name} · ${dateLabel(week)} – ${dateLabel(addDays(week, 6))}`} className="planner-fill-modal" onClose={() => setRandomOpen(false)}>
      <form className="planner-fill-form" onSubmit={event => { event.preventDefault(); randomFill(); setRandomOpen(false); }}>
        <p className="planner-muted">Random untuk {roster.length} staff pada daftar. Penugasan lain ikut dihitung ke target.</p><div className="planner-fields"><label>Target jam / staff<input type="number" min={0.5} max={168} step={0.5} value={targetHours} onChange={(e) => setTargetHours(Math.min(168, Math.max(0, Number(e.target.value))))} /></label><div className="planner-time-fields"><label>Mulai default<input type="time" step={1800} required value={defaultStart} onChange={(e) => setDefaultStart(e.target.value)} /></label><label>Durasi (jam)<input type="number" min={0.5} max={24} step={0.5} value={durationHours} onChange={(e) => setDurationHours(Math.min(24, Math.max(0.5, Number(e.target.value))))} /></label></div><fieldset className="planner-random-days"><legend>Hari yang boleh diisi</legend>{DAY_NAMES.map((name, day) => <label key={name}><input type="checkbox" checked={randomDays.includes(day)} onChange={(e) => setRandomDays(e.target.checked ? [...randomDays, day] : randomDays.filter((d) => d !== day))} /><span>{name}</span></label>)}</fieldset></div><p className="planner-remaining"><strong>{hoursLabel(remaining)} jam</strong> target daftar belum terisi</p><p className="planner-muted">Random mengisi maksimal satu shift per hari tanpa menimpa jadwal yang ada. Hasil ditambahkan ke draft, lalu disimpan melalui Commit jadwal.</p>
        <div className="planner-fill-footer"><button type="button" className="planner-secondary" onClick={() => setRandomOpen(false)}>Batal</button><button type="submit" className="planner-random-button" disabled={saving || !roster.length || !randomDays.length || !defaultStart || targetHours <= 0}>Random sampai target</button></div>
      </form>
    </Modal>}
  </main>;
}
