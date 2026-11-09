"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StaffingHeader } from "./navigation";
import { Modal, ArrowIcon } from "./modal";
import { ActionForm } from "@/components/staffing-dashboard";
import { StoreForm } from "@/components/store-settings";
import { UserForm } from "@/components/user-management";
import { RuleForm } from "./payroll-panel";
import { localTime, type StaffingData } from "@/lib/staffing/model";
import { rupiah, type StaffDetail } from "@/lib/staffing/operations-model";
import type { StoreAdminSummary } from "@/lib/store-settings";
import type { ManagedUser } from "@/lib/users";

const sections = [
  { id: "regions", label: "Region", group: "Organisasi", description: "Wilayah dan penempatan store", path: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" },
  { id: "stores", label: "Store", group: "Organisasi", description: "Cabang, zona waktu, dan integrasi", path: "M4 10v10h16V10M3 4h18v6H3zM9 20v-6h6v6" },
  { id: "users", label: "Akun pengguna", group: "Akses", description: "Akun admin dan manager", path: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" },
  { id: "access", label: "Akses manager", group: "Akses", description: "Cakupan region yang dikelola", path: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6" },
  { id: "telegram", label: "Telegram", group: "Operasional", description: "Bot staffing dan grup store", path: "m3 10 18-7-4 18-6-6-4 3 1-6 9-6-12 7-2-3Z" },
  { id: "rules", label: "Aturan payroll", group: "Operasional", description: "Tarif dan potongan per staff", path: "M6 3h12v18H6zM9 7h6M9 11h6M9 15h2M13 15h2M9 18h2M13 18h2" },
];
function Icon({ path }: { path: string }) { return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>; }

function PayrollSettings({ data, staffId }: { data: StaffingData; staffId?: string }) {
  const router = useRouter();
  const id = data.staff.some(staff => staff.id === staffId) ? staffId! : data.staff[0]?.id || "";
  const [detail, setDetail] = useState<StaffDetail | null>(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); setDetail(null); setError("");
    fetch(`/api/staffing/operations?view=staff&staff=${id}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const value = await response.json(); if (!response.ok) throw new Error(value.error);
      if (!controller.signal.aborted) setDetail(value);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Aturan belum dapat dimuat."); });
    return () => controller.abort();
  }, [id, data, retry]);
  if (!data.staff.length) return <p className="ops-empty">Tambahkan staff dari Staff Management sebelum mengatur payroll.</p>;
  const today = detail ? localTime(new Date().toISOString(), detail.store.time_zone).slice(0, 10) : "";
  const current = detail?.rules.find(rule => rule.effective_from <= today);
  return <><label className="ops-settings-staff-select">Pilih staff<select value={id} onChange={event => router.push(`/staffing/settings?section=rules&staff=${event.target.value}`)}>{data.staff.map(staff => <option key={staff.id} value={staff.id}>{staff.full_name}</option>)}</select></label>
    {error ? <p className="ops-error" role="alert">{error} <button type="button" className="ops-link" onClick={() => setRetry(value => value + 1)}>Coba lagi</button></p> : !detail ? <p className="ops-muted" role="status">Memuat aturan staff…</p> : <><div className="ops-settings-rule-summary"><div><strong>{detail.profile.full_name}</strong><span>{detail.store.name}</span></div><div><strong>{current ? rupiah(current.normal_rate) + " / jam" : "Belum diatur"}</strong><span>{current ? `Berlaku ${current.effective_from}` : "Isi tarif yang telah disepakati"}</span></div></div><RuleForm key={current?.id || id} staffId={id} rule={current} today={today} /></>}
  </>;
}

export function StaffingSettings({ data, initialStores, initialUsers, section, staffId, bot }: {
  data: StaffingData; initialStores: StoreAdminSummary[]; initialUsers: ManagedUser[];
  section?: string; staffId?: string; bot: { username: string | null; configured: boolean };
}) {
  const router = useRouter();
  const active = sections.find(item => item.id === section) || sections[0];
  const [stores, setStores] = useState(initialStores), [users, setUsers] = useState(initialUsers);
  const [modal, setModal] = useState<string | null>(null);
  useEffect(() => { setStores(initialStores); setUsers(initialUsers); }, [initialStores, initialUsers]);
  const editingStore = stores.find(store => modal === `store:${store.id}`);
  const editingUser = users.find(user => modal === `user:${user.id}`);
  const editingGroup = data.groups.find(group => modal === `group:${group.chat_id}`);
  const unassigned = data.stores.filter(store => !store.region_id && store.active);
  const activeManagers = data.managers.filter(manager => manager.active && manager.role === "manager");
  const registeredStoreIds = new Set(data.groups.map(group => group.store_id));
  const availableGroups = data.stores.filter(store => store.active && store.region_id && !registeredStoreIds.has(store.id));
  const groupBlocked = availableGroups.length ? null : !data.stores.some(store => store.active)
    ? { message: "Belum ada store aktif. Tambahkan atau aktifkan store sebelum menghubungkan grup.", section: "stores", label: "Buka pengaturan Store" }
    : unassigned.some(store => !registeredStoreIds.has(store.id))
      ? { message: "Store aktif yang belum terhubung ke grup perlu dipetakan ke region terlebih dahulu.", section: "regions", label: "Atur region store" }
      : { message: "Semua store aktif sudah terhubung ke grup Telegram. Gunakan Ubah grup untuk mengganti grup yang terdaftar.", section: null, label: null };
  function done() { setModal(null); }
  function savedStores(value: StoreAdminSummary[]) { setStores(value); done(); router.refresh(); }
  function savedUsers(value: ManagedUser[]) { setUsers(value); done(); router.refresh(); }
  const newAction: Record<string, { label: string; modal: string; disabled?: boolean }> = {
    regions: { label: "Tambah region", modal: "region" }, stores: { label: "Tambah store", modal: "store:new" },
    users: { label: "Tambah akun", modal: "user:new" }, access: { label: "Tambah akses", modal: "access", disabled: !activeManagers.length || !data.regions.length },
    telegram: { label: "Hubungkan grup", modal: "group", disabled: !availableGroups.length },
  };
  const action = newAction[active.id];
  return <main className="ops-shell ops-settings-shell"><StaffingHeader title="Pengaturan" subtitle="Satu tempat untuk mengatur organisasi, akses, dan operasional tim." current="settings" canConfigure />
    <div className="ops-settings-layout"><aside className="ops-settings-sidebar"><nav aria-label="Kategori pengaturan">{["Organisasi", "Akses", "Operasional"].map(group => <div className="ops-settings-nav-group" key={group}><p>{group}</p>{sections.filter(item => item.group === group).map(item => <Link key={item.id} href={`/staffing/settings?section=${item.id}`} aria-current={active.id === item.id ? "page" : undefined}><Icon path={item.path} /><span>{item.label}</span><ArrowIcon /></Link>)}</div>)}</nav><Link className="ops-inline-link ops-settings-back" href="/"><ArrowIcon direction="left" /> Dashboard POS</Link></aside>
      <section className="ops-settings-content" aria-labelledby="settings-section-title" key={active.id}><header className="ops-settings-section-heading"><div><h2 id="settings-section-title">{active.label}</h2><p>{active.description}</p></div>{action && <button type="button" className="ops-button" disabled={action.disabled} aria-describedby={active.id === "telegram" && groupBlocked ? "telegram-group-prerequisite" : undefined} onClick={() => setModal(action.modal)}>+ {action.label}</button>}</header>
        <div className="ops-settings-panel">
          {active.id === "regions" && <><p className="ops-muted">Kelompokkan store ke region untuk menentukan cakupan manager.</p><div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Region</th><th>Store terhubung</th><th>Manager</th></tr></thead><tbody>{data.regions.map(region => <tr key={region.id}><td><strong>{region.name}</strong></td><td className="ops-description-cell">{data.stores.filter(store => store.region_id === region.id).map(store => store.name).join(", ") || "Belum ada store"}</td><td>{data.managers.filter(manager => manager.region_ids.includes(region.id)).map(manager => manager.username).join(", ") || "Belum ditetapkan"}</td></tr>)}</tbody></table></div>{!data.regions.length && <p className="ops-empty">Belum ada region. Tambahkan region pertama untuk menghubungkan store.</p>}<div className="ops-settings-subsection"><div><h3>Hubungkan store ke region</h3><p className="ops-muted">{unassigned.length ? `${unassigned.length} store aktif belum memiliki region.` : "Semua store aktif sudah terhubung ke region."}</p></div><button type="button" className="ops-secondary" disabled={!unassigned.length || !data.regions.length} onClick={() => setModal("mapping")}>Hubungkan store</button></div></>}
          {active.id === "stores" && <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Store</th><th>Zona waktu</th><th>Region</th><th>Integrasi POS</th><th>Status</th><th>Pengaturan</th></tr></thead><tbody>{stores.map(store => <tr key={store.id}><td><strong>{store.name}</strong></td><td>{store.timeZone}</td><td>{data.regions.find(region => region.id === data.stores.find(item => item.id === store.id)?.region_id)?.name || "Belum dihubungkan"}</td><td><span className={`ops-badge ${store.hasRefreshToken ? "is-confirmed" : "is-pending"}`}>{store.hasRefreshToken ? "Terhubung" : "Belum diatur"}</span></td><td>{store.active ? "Aktif" : "Nonaktif"}</td><td><button type="button" className="ops-link" onClick={() => setModal(`store:${store.id}`)}>Atur store</button></td></tr>)}</tbody></table>{!stores.length && <p className="ops-empty">Belum ada store.</p>}</div>}
          {active.id === "users" && <><p className="ops-muted">Admin mengelola seluruh dashboard. Manager mendapat akses staffing sesuai region yang ditetapkan.</p><div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Akun</th><th>Peran</th><th>Status</th><th>Pengaturan</th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><strong>{user.username}</strong></td><td>{user.role === "manager" ? "Manager staffing" : "Admin"}</td><td><span className={`ops-badge ${user.active ? "is-confirmed" : "is-cancelled"}`}>{user.active ? "Aktif" : "Nonaktif"}</span></td><td><button type="button" className="ops-link" onClick={() => setModal(`user:${user.id}`)}>Atur akun</button></td></tr>)}</tbody></table>{!users.length && <p className="ops-empty">Belum ada akun pengguna.</p>}</div></>}
          {active.id === "access" && <><p className="ops-muted">Tetapkan region untuk akun manager yang sudah aktif.</p><div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Manager</th><th>Region yang dikelola</th><th>Status akun</th></tr></thead><tbody>{data.managers.filter(manager => manager.role === "manager").map(manager => <tr key={manager.id}><td><strong>{manager.username}</strong></td><td className="ops-description-cell">{data.regions.filter(region => manager.region_ids.includes(region.id)).map(region => region.name).join(", ") || "Belum mendapat akses"}</td><td>{manager.active ? "Aktif" : "Nonaktif"}</td></tr>)}</tbody></table>{!data.managers.some(manager => manager.role === "manager") && <p className="ops-empty">Buat akun manager dari kategori Akun Pengguna terlebih dahulu.</p>}</div></>}
          {active.id === "telegram" && <><div className="ops-settings-bot"><div className="ops-settings-bot-icon"><Icon path={sections[4].path} /></div><div><h3>Bot staffing</h3><p>{bot.username ? `@${bot.username}` : "Username bot belum diatur"}</p></div><span className={`ops-badge ${bot.configured && bot.username ? "is-confirmed" : "is-pending"}`}>{bot.configured && bot.username ? "Konfigurasi tersedia" : "Belum dikonfigurasi"}</span></div><p className="ops-muted">Hubungkan satu grup Telegram dengan store untuk absensi komunal. Undangan personal tersedia pada Pengaturan Profil staff.</p>{groupBlocked && <p className="notice" id="telegram-group-prerequisite">{groupBlocked.message}{groupBlocked.section && <> <Link className="ops-inline-link" href={`/staffing/settings?section=${groupBlocked.section}`}>{groupBlocked.label} <ArrowIcon /></Link></>}</p>}<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Store</th><th>Grup Telegram</th><th>Status</th><th>Pengaturan</th></tr></thead><tbody>{data.groups.map(group => <tr key={group.chat_id}><td>{data.stores.find(store => store.id === group.store_id)?.name}</td><td>{group.chat_id}</td><td><span className="ops-badge is-confirmed">Terdaftar</span></td><td><button type="button" className="ops-link" onClick={() => setModal(`group:${group.chat_id}`)}>Ubah grup</button></td></tr>)}</tbody></table>{!data.groups.length && <p className="ops-empty">Belum ada grup yang terhubung.</p>}</div></>}
          {active.id === "rules" && <PayrollSettings data={data} staffId={staffId} />}
        </div>
      </section>
    </div>
    {modal === "region" && <Modal title="Tambah region" onClose={done}><ActionForm action="region" label="Simpan region" onResult={done}><label>Nama region<input name="name" required maxLength={100} placeholder="Contoh: Jatinangor" /></label></ActionForm></Modal>}
    {modal === "mapping" && <Modal title="Hubungkan store ke region" onClose={done}><ActionForm action="store_region" label="Hubungkan store" onResult={done}><label>Store<select name="store_id" required defaultValue=""><option value="" disabled>Pilih store</option>{unassigned.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label>Region<select name="region_id" required defaultValue=""><option value="" disabled>Pilih region</option>{data.regions.map(region => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label></ActionForm></Modal>}
    {modal === "access" && <Modal title="Tambah akses manager" onClose={done}><ActionForm action="manager_region" label="Simpan akses" onResult={done}><label>Akun manager<select name="user_id" required defaultValue=""><option value="" disabled>Pilih manager</option>{activeManagers.map(manager => <option key={manager.id} value={manager.id}>{manager.username}</option>)}</select></label><label>Region<select name="region_id" required defaultValue=""><option value="" disabled>Pilih region</option>{data.regions.map(region => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label></ActionForm></Modal>}
    {(editingStore || modal === "store:new") && <Modal title={editingStore ? "Pengaturan store" : "Tambah store"} description={editingStore?.name} onClose={done} wide><StoreForm store={editingStore} onSaved={savedStores} /></Modal>}
    {(editingUser || modal === "user:new") && <Modal title={editingUser ? "Pengaturan akun" : "Tambah akun"} description={editingUser?.username} onClose={done} wide><UserForm user={editingUser} onSaved={savedUsers} /></Modal>}
    {(modal === "group" || editingGroup) && <Modal title={editingGroup ? "Ubah grup Telegram" : "Hubungkan grup Telegram"} description={editingGroup ? "Selesaikan proses absensi, tukar shift, dan pengiriman pesan di grup lama sebelum mengganti grup." : undefined} onClose={done}><ActionForm action="group" label={editingGroup ? "Simpan perubahan grup" : "Hubungkan grup"} onResult={done}>
      {editingGroup ? <><input type="hidden" name="store_id" value={editingGroup.store_id} /><input type="hidden" name="previous_chat_id" value={String(editingGroup.chat_id)} /><label>Store<input readOnly value={data.stores.find(store => store.id === editingGroup.store_id)?.name || ""} /></label></> : <label>Store<select name="store_id" required defaultValue=""><option value="" disabled>Pilih store</option>{availableGroups.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>}
      <label>{editingGroup ? "ID grup Telegram baru" : "ID grup Telegram"}<input name="chat_id" required pattern="-[1-9][0-9]*" placeholder="-100…" defaultValue={editingGroup ? String(editingGroup.chat_id) : ""} /></label>
      {editingGroup && <label>Alasan perubahan<textarea name="note" required minLength={5} maxLength={500} placeholder="Contoh: pindah ke grup operasional store yang baru" /></label>}
    </ActionForm></Modal>}
  </main>;
}
