"use client";
import { useState } from "react";
import Link from "next/link";
import { StaffingHeader } from "./navigation";
import { OperationForm } from "./operation-form";
import { AttendanceList, LeaveList } from "./record-lists";
import { Finance } from "./finance";
import { TimeChip } from "./time-chip";
import { ArrowIcon } from "./modal";
import { localTime } from "@/lib/staffing/model";
import { rupiah, requestNeedsAction, type StaffDetail } from "@/lib/staffing/operations-model";
const tabs = [["jadwal", "Jadwal & Absensi"], ["izin", "Izin & sakit"], ["keuangan", "Keuangan"]];

export function StaffProfile({ detail, canConfigure, initialTab = "jadwal" }: { detail: StaffDetail; canConfigure: boolean; initialTab?: string }) {
  const requestedTab = ["kasbon", "bonus", "payroll"].includes(initialTab) ? "keuangan" : initialTab === "absensi" ? "jadwal" : initialTab;
  const [tab, setTab] = useState(tabs.some(([id]) => id === requestedTab) ? requestedTab : "jadwal");
  const [invitation, setInvitation] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  async function invite() {
    setInviting(true); setInviteError("");
    try {
      const response = await fetch("/api/staffing/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staff_id: detail.profile.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Undangan belum dapat dibuat.");
      setInvitation(result.invitation);
    } catch (error) { setInviteError(error instanceof Error ? error.message : "Undangan belum dapat dibuat."); }
    finally { setInviting(false); }
  }
  const today = localTime(new Date().toISOString(), detail.store.time_zone).slice(0, 10);
  const profile = detail.profile;
  const actionCounts: Record<string, number> = {
    jadwal: detail.sessions.filter(session => session.verification_state === "pending").length,
    izin: detail.requests.filter(request => request.kind !== "cash_advance" && requestNeedsAction(request)).length,
    keuangan: detail.requests.filter(request => request.kind === "cash_advance" && requestNeedsAction(request)).length,
  };
  return <main className="ops-shell">
    <StaffingHeader title={profile.full_name} subtitle={`${profile.code} · ${detail.store.name} · ${profile.telegram_linked ? "Telegram tertaut" : "Telegram belum tertaut"}`} current="staff" canConfigure={canConfigure} />
    <div className="ops-breadcrumb"><Link className="ops-inline-link" href="/staffing/staff"><ArrowIcon direction="left" /> Semua staff</Link><span className={`ops-badge ${profile.active ? "is-confirmed" : "is-cancelled"}`}>{profile.active ? "Aktif" : "Nonaktif"}</span></div>
    <div className="ops-metrics"><div><span>Saldo izin berbayar</span><strong>{detail.money.leave_balance === null ? "Belum dicatat" : `${detail.money.leave_balance} hari`}</strong></div><div><span>Jatah kasbon tersedia</span><strong>{rupiah(detail.money.available)}</strong></div><div><span>Kasbon belum lunas</span><strong>{rupiah(detail.money.outstanding)}</strong></div><div><span>Payroll terakhir</span><strong>{detail.payrolls[0] ? rupiah(detail.payrolls[0].result.net_pay) : "Belum ada payroll"}</strong></div></div>
    <details className="ops-panel"><summary>Pengaturan Profil</summary>
      <OperationForm action="profile" data={{ staff_id: profile.id }} label="Simpan profil" blocked={inviting} actions={<button type="button" className="ops-telegram-button" onClick={invite} disabled={profile.telegram_linked || !profile.active} title={profile.telegram_linked ? "Akun Telegram sudah tertaut" : !profile.active ? "Aktifkan staff untuk membuat undangan" : undefined}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.7 3.4 18.2 20c-.3 1.2-1 1.5-2 .9l-5.4-4-2.6 2.5c-.3.3-.5.5-1 .5l.4-5.5 10-9c.4-.4-.1-.6-.7-.2L4.6 13 0 11.5c-1-.3-1.1-1 .2-1.5l20-7.7c1-.4 1.8.2 1.5 1.1Z" /></svg>
        {inviting ? "Membuat undangan…" : profile.telegram_linked ? "Telegram tertaut" : "Buat undangan Telegram"}</button>}><label>Nama lengkap<input name="full_name" defaultValue={profile.full_name} maxLength={120} required /></label><label>Plafon kasbon (Rp)<input name="ceiling" type="number" min={0} step={1} defaultValue={profile.cash_advance_ceiling ?? ""} /><small>Kosong berarti belum ditetapkan. Penurunan plafon tidak menghapus utang berjalan.</small></label><label className="ops-check"><input type="checkbox" name="active" defaultChecked={profile.active} />Staff aktif</label></OperationForm>
      {inviteError && <p className="ops-error" role="alert">{inviteError}</p>}
      {invitation && <p className="ops-success">Kirim secara pribadi; berlaku 24 jam sekali pakai: <a href={invitation}>{invitation}</a></p>}
    </details>
    <div className="ops-tabs" role="tablist" aria-label="Detail staff">{tabs.map(([id, label]) => <button key={id} type="button" id={`staff-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`staff-panel-${id}`} onClick={() => setTab(id)}>{label}{actionCounts[id] > 0 && <span className="ops-tab-count" aria-label={`${actionCounts[id]} perlu tindakan`}>{actionCounts[id]}</span>}</button>)}</div>
    <div role="tabpanel" id={`staff-panel-${tab}`} aria-labelledby={`staff-tab-${tab}`}>
      {tab === "jadwal" && <><section className="ops-panel"><div className="ops-section-heading"><div><h2>Jadwal ter-commit</h2><p className="ops-muted">Tanggal mengikuti timezone store tempat bekerja.</p></div><Link className="ops-inline-link" href="/staffing/schedule">Buka scheduling <ArrowIcon /></Link></div><div className="ops-table-wrap ops-schedule-history" role="region" aria-label="Jadwal staff" tabIndex={0}><table className="ops-table"><thead><tr><th>Shift</th><th>Store</th><th>Mulai</th><th>Selesai</th><th>Status</th></tr></thead><tbody>{detail.shifts.map(s => <tr key={s.id}><td>{s.label}</td><td>{s.store_name}</td><td><TimeChip value={s.starts_at} zone={s.time_zone} /></td><td><TimeChip value={s.ends_at} zone={s.time_zone} /></td><td><span className="ops-badge is-confirmed">Committed</span></td></tr>)}</tbody></table></div>{!detail.shifts.length && <p className="ops-empty">Belum ada jadwal yang di-commit.</p>}</section><AttendanceList sessions={detail.sessions} staffName={profile.full_name} /></>}
      {tab === "izin" && <LeaveList detail={detail} today={today} />}
      {tab === "keuangan" && <Finance detail={detail} today={today} />}
    </div>
  </main>;
}
