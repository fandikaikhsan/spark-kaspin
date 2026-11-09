"use client";
import Link from "next/link";
import { useState } from "react";
import { StaffingHeader } from "./navigation";
import { Modal, ArrowIcon } from "./modal";
import { OperationForm } from "./operation-form";
import { rupiah, type RosterStaff } from "@/lib/staffing/operations-model";
import type { StaffingStore } from "@/lib/staffing/model";

export function StaffRoster({ staff, stores, canConfigure }: { staff: RosterStaff[]; stores: StaffingStore[]; canConfigure: boolean }) {
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const rows = staff.filter(s => (!store || s.home_store_id === store) && (status === "all" || (status === "active" ? s.active : !s.active)) && `${s.full_name} ${s.code}`.toLowerCase().includes(query.toLowerCase()));
  const eligibleStores = stores.filter(s => s.active && s.region_id);
  return <main className="ops-shell">
    <StaffingHeader title="Staff Management" subtitle="Data tim, jadwal, hak staff, dan riwayat penghasilan." current="staff" canConfigure={canConfigure} />
    <div className="ops-filterbar"><label>Cari staff<input placeholder="Nama atau kode staff" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>Store<select value={store} onChange={e => setStore(e.target.value)}><option value="">Semua store akses</option>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">Semua staff</option><option value="active">Aktif</option><option value="inactive">Nonaktif</option></select></label><strong>{rows.length} staff</strong><button className="ops-button" type="button" onClick={() => setCreating(true)} disabled={!eligibleStores.length}>+ Create staff</button></div>
    <section className="ops-panel"><div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Staff</th><th>Store</th><th>Saldo izin</th><th>Kasbon tersedia</th><th>Payroll terakhir</th><th>Status</th><th><span className="ops-sr-only">Detail</span></th></tr></thead>
      <tbody>{rows.map(s => <tr key={s.id}><td><Link href={`/staffing/staff/${s.id}`}><strong>{s.full_name}</strong></Link><small>{s.code} · {s.telegram_linked ? "Telegram tertaut" : "Belum tertaut"}</small></td><td>{s.store_name}</td><td>{s.money.leave_balance === null ? "Belum dicatat" : `${s.money.leave_balance} hari`}</td><td>{rupiah(s.money.available)}<small>Utang {rupiah(s.money.outstanding)}</small></td><td>{s.last_payroll === null ? "Belum ada payroll" : rupiah(s.last_payroll)}</td><td><span className={`ops-badge ${s.active ? "is-confirmed" : "is-cancelled"}`}>{s.active ? "Aktif" : "Nonaktif"}</span></td><td><Link className="ops-inline-link" href={`/staffing/staff/${s.id}`}>Detail <ArrowIcon /></Link></td></tr>)}</tbody>
    </table></div>{!rows.length && <p className="ops-empty">Tidak ada staff pada filter ini.</p>}</section>
    {creating && <Modal title="Create staff" description="Lengkapi profil dan saldo awal. Kode staff dibuat otomatis." onClose={() => setCreating(false)}>
      <OperationForm action="create_staff" label="Buat staff" onSaved={() => setCreating(false)}>
        <label>Nama lengkap<input name="full_name" required maxLength={120} autoComplete="off" placeholder="Nama lengkap staff" autoFocus /></label>
        <label>Home store<select name="home_store_id" required defaultValue={store && eligibleStores.some(s => s.id === store) ? store : ""}><option value="" disabled>Pilih home store</option>{eligibleStores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div className="ops-field-pair"><label>Saldo izin awal (hari)<input name="initial_leave" type="number" min={0} max={1000} step={0.5} placeholder="0" /><small>Kosong = 0 hari. Isi saldo awal yang disepakati.</small></label>
          <label>Plafon kasbon (Rp)<input name="ceiling" type="number" min={0} max={1000000000000} step={1} placeholder="0" /><small>Kosong = Rp0. Dapat diubah pada profil staff.</small></label></div>
      </OperationForm>
    </Modal>}
  </main>;
}
