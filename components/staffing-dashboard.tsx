"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { LogoutButton } from "@/components/logout-button";
import { localTime, type StaffingData, type AttendanceSession } from "@/lib/staffing/model";

export function ActionForm({ action, children, onResult, label = "Simpan" }: { action: string; children: ReactNode; label?: string; onResult?: (data: Record<string, string>) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setSaved(false);
    const form = event.currentTarget;
    try {
      const response = await fetch(`/api/staffing/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      if (response.status === 401) { window.location.assign("/login?next=/staffing"); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Tidak dapat menyimpan data.");
      onResult?.(data); setSaved(true); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat menyimpan data."); }
    finally { setBusy(false); }
  }
  return <form className="staffing-form" onSubmit={submit}>
    <fieldset disabled={busy}>{children}<button type="submit">{busy ? "Menyimpan…" : label}</button></fieldset>
    {error && <p className="error" role="alert">{error}</p>}
    {saved && <p className="notice" role="status">Tersimpan.</p>}
  </form>;
}

function StoreSelect({ data, name = "store_id", assignedOnly = false, activeOnly = true }: { data: StaffingData; name?: string; assignedOnly?: boolean; activeOnly?: boolean }) {
  return <label>Store<select name={name} required defaultValue=""><option value="" disabled>Pilih store</option>{data.stores.filter((s) => (!activeOnly || s.active) && (!assignedOnly || s.region_id)).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.time_zone}</option>)}</select></label>;
}
function RegionSelect({ data }: { data: StaffingData }) {
  return <label>Region<select name="region_id" required defaultValue=""><option value="" disabled>Pilih region</option>{data.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>;
}
function StaffSelect({ data }: { data: StaffingData }) {
  return <label>Staff<select name="staff_id" required defaultValue=""><option value="" disabled>Pilih staff</option>{data.staff.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.full_name} · {s.code}</option>)}</select></label>;
}
function AttendanceRow({ session, data }: { session: AttendanceSession; data: StaffingData }) {
  const store = data.stores.find((s) => s.id === session.store_id);
  const zone = store?.time_zone || "Asia/Jakarta";
  const effectiveIn = session.corrected_in_at || session.check_in_at;
  const effectiveOut = session.corrected_out_at || session.check_out_at;
  const format = (value: string) => new Intl.DateTimeFormat("id-ID", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const late = Math.max(0, Math.ceil((Date.parse(effectiveIn) - Date.parse(session.starts_at)) / 60000));
  const [evidence, setEvidence] = useState<{ attempt_id: string; kind: string; latitude: number; longitude: number }[] | null>(null);
  const [error, setError] = useState("");
  async function loadEvidence() {
    try {
      const response = await fetch(`/api/staffing/evidence?session=${session.id}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Bukti tidak dapat dimuat.");
      setEvidence(payload);
    } catch (err) { setError(err instanceof Error ? err.message : "Bukti tidak dapat dimuat."); }
  }
  return <article className="staffing-attendance">
    <div><h3>{session.full_name}</h3><p>{store?.name} · {session.label}</p></div>
    <dl><div><dt>Masuk</dt><dd>{format(effectiveIn)}</dd></div><div><dt>Pulang</dt><dd>{effectiveOut ? format(effectiveOut) : "Sesi terbuka"}</dd></div><div><dt>Terlambat</dt><dd>{late} menit</dd></div></dl>
    {(session.corrected_in_at || session.corrected_out_at) && <p className="staffing-muted">Sudah dikoreksi manager; catatan asli tetap tersimpan.</p>}
    <details><summary>Bukti absensi</summary>
      <button className="text-button" type="button" onClick={loadEvidence}>Muat bukti</button>
      {error && <p role="alert">{error}</p>}
      {evidence?.map((e) => <p key={e.attempt_id}>{e.kind === "check_in" ? "Masuk" : "Pulang"}: {e.latitude}, {e.longitude} · <a href={`/api/staffing/evidence?attempt=${e.attempt_id}`} target="_blank" rel="noreferrer">Buka foto</a></p>)}
    </details>
    <details><summary>Koreksi oleh manager</summary>
      <ActionForm action="correction" label="Simpan koreksi">
        <input type="hidden" name="session_id" value={session.id} />
        <label>Jam masuk ({zone})<input type="datetime-local" name="check_in_local" step={1} required defaultValue={localTime(effectiveIn, zone, true)} /></label>
        <label>Jam pulang ({zone}, kosong bila masih bekerja)<input type="datetime-local" name="check_out_local" step={1} defaultValue={effectiveOut ? localTime(effectiveOut, zone, true) : ""} /></label>
        <label>Alasan dan bukti pendukung<input name="reason" required minLength={5} maxLength={1000} /></label>
      </ActionForm>
    </details>
  </article>;
}

export function StaffingDashboard({ data }: { data: StaffingData }) {
  const [invitation, setInvitation] = useState("");
  return <main className="shell staffing-shell">
    <header className="settings-header"><div><p className="eyebrow">Spark Intelligence</p><h1>Staffing</h1><p className="subtitle">Jadwal dan absensi store dalam region yang kamu kelola.</p></div>
      <nav className="header-actions" aria-label="Navigasi"><Link href="/staffing/schedule">Jadwal shift</Link>{data.canConfigure && <><Link href="/">Dashboard POS</Link><Link href="/settings">Akun & store</Link></>}<LogoutButton /></nav>
    </header>
    <p className="notice">Absen dilakukan di grup melalui /masuk dan /pulang, konfirmasi shift, lokasi, lalu foto. Waktu bukti lengkap menjadi waktu absen. Durasi terlambat belum menghasilkan penalti otomatis.</p>
    {!data.stores.length && <p className="notice">Belum ada store yang dapat kamu kelola. Minta administrator menetapkan akses region.</p>}
    <div className="staffing-stats"><div><strong>{data.staff.length}</strong><span>Staff terdaftar</span></div><div><strong>{data.sessions.filter((s) => !s.corrected_out_at && !s.check_out_at).length}</strong><span>Sesi terbuka dalam rekap</span></div><div><strong>{data.reports.length}</strong><span>Laporan perlu diperiksa</span></div></div>
    {data.canConfigure && <section className="staffing-panel"><h2>Region dan akses</h2><p>Tambahkan region, hubungkan store yang sudah ada, lalu tetapkan akun manager. Buat akun manager melalui Akun & store.</p>
      <div className="staffing-columns">
        <div><h3>Tambah region</h3><ActionForm action="region"><label>Nama region<input name="name" required maxLength={100} /></label></ActionForm></div>
        <div><h3>Hubungkan store</h3><ActionForm action="store_region"><label>Store tanpa region<select name="store_id" required defaultValue=""><option value="" disabled>Pilih store</option>{data.stores.filter((s) => !s.region_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><RegionSelect data={data} /></ActionForm></div>
        <div><h3>Berikan akses manager</h3><ActionForm action="manager_region"><label>Akun manager<select name="user_id" required defaultValue=""><option value="" disabled>Pilih akun</option>{data.managers.filter((m) => m.role === "manager" && m.active).map((m) => <option key={m.id} value={m.id}>{m.username}</option>)}</select></label><RegionSelect data={data} /></ActionForm></div>
      </div>
      <ul>{data.regions.map((r) => <li key={r.id}><strong>{r.name}</strong>: {data.stores.filter((s) => s.region_id === r.id).map((s) => s.name).join(", ") || "Belum ada store"} · Manager: {data.managers.filter((m) => m.region_ids.includes(r.id)).map((m) => m.username).join(", ") || "Belum ditetapkan"}</li>)}</ul>
    </section>}
    <div className="staffing-columns">
      <section className="staffing-panel"><h2>Data staff</h2><ActionForm action="staff"><label>Kode staff<input name="code" required pattern="[A-Za-z0-9._-]{1,40}" maxLength={40} /></label><label>Nama lengkap<input name="full_name" required maxLength={120} /></label><StoreSelect data={data} name="home_store_id" assignedOnly /></ActionForm>
        <ul className="staffing-list">{data.staff.map((s) => <li key={s.id}><strong>{s.full_name}</strong> · {s.code}<br /><span>{data.stores.find((store) => store.id === s.home_store_id)?.name} · {s.telegram_linked ? "Telegram tertaut" : "Belum tertaut"}</span></li>)}</ul>
        <h3>Undangan Telegram</h3><ActionForm action="invite" label="Buat undangan" onResult={(result) => setInvitation(result.invitation)}><StaffSelect data={{ ...data, staff: data.staff.filter((s) => !s.telegram_linked) }} /></ActionForm>
        {invitation && <p className="notice staffing-invitation" role="status">Kirim secara pribadi ke staff yang bersangkutan. Berlaku 24 jam, sekali pakai.<br /><a href={invitation} target="_blank" rel="noreferrer">{invitation}</a></p>}
      </section>
      <section className="staffing-panel"><h2>Jadwal mingguan</h2><p>Plot staff ke timetable, geser dan resize shift, lalu commit jadwal satu minggu sekaligus.</p><Link className="planner-primary" href="/staffing/schedule">Buka perencana jadwal →</Link></section>
    </div>
    {data.canConfigure && <section className="staffing-panel"><h2>Grup Telegram store</h2><p>Gunakan bot staffing khusus untuk grup dan chat pribadi staff. Bot POS existing tetap menangani sinkronisasi penjualan.</p><ActionForm action="group" label="Daftarkan grup"><StoreSelect data={data} assignedOnly /><label>Telegram group ID<input name="chat_id" required pattern="-[0-9]+" placeholder="-100…" /></label></ActionForm><ul>{data.groups.map((g) => <li key={g.chat_id}>{data.stores.find((s) => s.id === g.store_id)?.name}: {g.chat_id}</li>)}</ul></section>}
    {!!data.reports.length && <section className="staffing-panel"><h2>Laporan ketidaksesuaian</h2><p>Laporan rekan kerja perlu diperiksa; belum mengubah absensi.</p>{data.reports.map((r) => <div key={r.id}><p>{data.sessions.find((s) => s.id === r.session_id)?.full_name || "Absensi"} · Pelapor: {r.reporter_name}</p><ActionForm action="resolve_report" label="Tandai sudah diperiksa"><input type="hidden" name="report_id" value={r.id} /><label>Hasil pemeriksaan<input name="reason" required minLength={5} maxLength={1000} /></label></ActionForm></div>)}</section>}
    <section className="staffing-panel"><div className="staffing-heading"><h2>Rekap absensi terbaru</h2><button className="text-button" type="button" onClick={() => window.location.reload()}>Perbarui</button></div><p>Menampilkan hingga 100 sesi terbaru. Jam kerja aktual dan lembur yang disetujui merupakan catatan terpisah.</p>{!data.sessions.length && <p className="staffing-muted">Belum ada absensi tercatat.</p>}{data.sessions.map((session) => <AttendanceRow session={session} data={data} key={session.id} />)}</section>
  </main>;
}
