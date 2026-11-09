"use client";
import { PayrollDocument } from "./payroll-document";
import { useState } from "react";
import { Modal } from "./modal";
import { OperationForm } from "./operation-form";
import { RequestCard, RequestForm, RequestStatusBadge } from "./requests";
import { PayrollPanel, PayrollBreakdown, RuleForm } from "./payroll-panel";
import { dateTime } from "./record-lists";
import { rupiah, requestNeedsAction, requestStatusLabel, type StaffDetail, type StaffRequest } from "@/lib/staffing/operations-model";

type Entry = { id: string; kind: string; date: string; title: string; amount: number | null; state: string; reference: string; request?: StaffRequest };
export function Finance({ detail, today }: { detail: StaffDetail; today: string }) {
  const [category, setCategory] = useState("all");
  const [newKind, setNewKind] = useState("kasbon");
  const [modal, setModal] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const staffId = detail.profile.id;
  const cash = detail.requests.filter(r => r.kind === "cash_advance");
  const actionCount = cash.filter(requestNeedsAction).length;
  const entries: Entry[] = [
    ...cash.map(r => ({ id: `request:${r.id}`, reference: r.id, kind: "kasbon", date: r.created_at, title: "Pengajuan kasbon", amount: r.amount, state: requestStatusLabel(r), request: r })),
    ...detail.cash_ledger.filter(e => e.kind === "repayment").map(e => ({ id: `ledger:${e.id}`, reference: e.id, kind: "kasbon", date: e.created_at, title: e.reason, amount: Number(e.amount), state: "Dibukukan" })),
    ...detail.bonuses.map(b => ({ id: `bonus:${b.id}`, reference: b.id, kind: "bonus", date: b.bonus_date, title: b.reason, amount: Number(b.amount), state: b.payroll_id ? "Masuk payroll final" : "Menunggu payroll" })),
    ...detail.discipline.map(d => ({ id: `sp:${d.id}`, reference: d.id, kind: "sp", date: d.created_at, title: `SP · ${d.points} poin`, amount: null, state: "Tercatat" })),
    ...detail.payrolls.map(p => ({ id: `payroll:${p.id}`, reference: p.id, kind: "payroll", date: p.created_at, title: `${p.period_start} – ${p.period_end}`, amount: p.result.net_pay, state: "Final" })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const rows = entries.filter(e => category === "all" || e.kind === category);
  const entry = entries.find(e => e.id === selected);
  const request = entry && cash.find(r => r.id === entry.reference);
  const payroll = entry && detail.payrolls.find(p => p.id === entry.reference);
  const bonus = entry && detail.bonuses.find(b => b.id === entry.reference);
  const discipline = entry && detail.discipline.find(d => d.id === entry.reference);
  const ledger = entry && detail.cash_ledger.find(e => e.id === entry.reference);
  const kindLabel: Record<string, string> = { kasbon: "Kasbon", bonus: "Bonus / THR", sp: "SP", payroll: "Payroll" };
  return <section className="ops-panel"><div className="ops-section-heading"><div><h2 className="ops-title-with-count">Keuangan{actionCount > 0 && <span className="ops-badge is-action-required">{actionCount} perlu tindakan</span>}</h2><p className="ops-muted">Kasbon, bonus, SP, dan payroll dalam satu riwayat. Kasbon yang dicairkan masuk ke potongan payroll.</p></div><div className="ops-action-group"><button type="button" className="ops-secondary" onClick={() => setModal("rules")}>Aturan payroll</button><button type="button" className="ops-button" onClick={() => setModal("payroll")}>Proses payroll</button></div></div>
    <div className="ops-finance-summary"><div><span>Plafon kasbon</span><strong>{rupiah(detail.money.ceiling)}</strong></div><div><span>Kasbon tersedia</span><strong>{rupiah(detail.money.available)}</strong></div><div><span>Belum lunas</span><strong>{rupiah(detail.money.outstanding)}</strong></div><div><span>Dicadangkan</span><strong>{rupiah(detail.money.reserved)}</strong></div></div>
    <div className="ops-list-toolbar"><label>Tampilkan<select value={category} onChange={e => setCategory(e.target.value)}><option value="all">Semua catatan</option>{Object.entries(kindLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="ops-create-actions"><label>Catatan baru<select value={newKind} onChange={e => setNewKind(e.target.value)}><option value="kasbon">Kasbon</option><option value="bonus">Bonus / THR</option><option value="sp">SP</option><option value="repayment">Pelunasan kasbon</option></select></label><button type="button" className="ops-secondary" onClick={() => setModal(newKind)}>+ Tambah</button></div></div>
    <div className="ops-table-wrap"><table className="ops-table ops-record-table"><thead><tr><th>Tanggal</th><th>Jenis</th><th>Keterangan</th><th>Nominal / net</th><th>Status</th><th>Detail</th></tr></thead><tbody>{rows.map(row => <tr className={`ops-clickable-row${row.request && requestNeedsAction(row.request) ? " needs-review" : ""}`} key={row.id} onClick={() => setSelected(row.id)}><td>{row.date.slice(0, 10)}</td><td>{kindLabel[row.kind]}</td><td className="ops-description-cell">{row.title}</td><td>{row.amount === null ? "—" : rupiah(row.amount)}</td><td>{row.request ? <RequestStatusBadge request={row.request} /> : <span className="ops-badge">{row.state}</span>}</td><td><button type="button" className="ops-link" aria-label={`Detail ${kindLabel[row.kind]} ${row.date.slice(0, 10)}`} onClick={e => { e.stopPropagation(); setSelected(row.id); }}>{row.request && requestNeedsAction(row.request) ? row.request.status === "approved" ? "Konfirmasi pencairan" : "Review kasbon" : "Lihat detail"}</button></td></tr>)}</tbody></table></div>{!rows.length && <p className="ops-empty">Belum ada catatan pada kategori ini.</p>}
    {entry && <Modal title={`Detail ${kindLabel[entry.kind].toLowerCase()}`} description={detail.profile.full_name} onClose={() => setSelected(null)} wide={entry.kind === "payroll"}>
      {request ? <RequestCard request={request} /> : payroll ? <><p>Periode {payroll.period_start} – {payroll.period_end}</p><p className="ops-muted">Final · {dateTime(payroll.created_at, detail.store.time_zone)}</p><PayrollBreakdown result={payroll.result} /><PayrollDocument payrollId={payroll.id} /></> : <dl className="ops-detail-grid"><div><dt>Tanggal</dt><dd>{entry.date.slice(0, 10)}</dd></div><div><dt>{discipline ? "Poin SP" : "Nominal"}</dt><dd>{discipline ? `${discipline.points} poin` : rupiah(entry.amount)}</dd></div><div className="is-full"><dt>Alasan / keterangan</dt><dd>{bonus?.reason || discipline?.reason || ledger?.reason}</dd></div><div className="is-full"><dt>Status</dt><dd>{entry.state}</dd></div></dl>}
      {discipline && <p className="ops-muted">SP merupakan catatan disiplin untuk review manager; tidak memicu potongan payroll otomatis.</p>}
    </Modal>}
    {modal === "kasbon" && <Modal title="Tambah kasbon" description={`Catat pengajuan untuk ${detail.profile.full_name}. Persetujuan dan konfirmasi pencairan dilakukan dari detail pengajuan.`} onClose={() => setModal(null)}><RequestForm staffId={staffId} today={today} available={detail.money.available} initialKind="cash_advance" onSaved={() => setModal(null)} /></Modal>}
    {modal === "bonus" && <Modal title="Catat bonus / THR" onClose={() => setModal(null)}><OperationForm action="bonus" data={{ staff_id: staffId }} label="Simpan bonus" onSaved={() => setModal(null)}><label>Tanggal bonus<input name="bonus_date" type="date" required defaultValue={today} /></label><label>Nominal (Rp)<input name="amount" type="number" min={1} step={1} required /></label><label>Jenis / alasan bonus<input name="reason" required minLength={5} placeholder="Bonus kinerja / THR" /></label></OperationForm></Modal>}
    {modal === "sp" && <Modal title="Catat SP" onClose={() => setModal(null)}><OperationForm action="discipline" data={{ staff_id: staffId }} label="Simpan SP" onSaved={() => setModal(null)}><label>Bobot poin<select name="points" defaultValue="1">{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} poin</option>)}</select></label><label>Catatan pemeriksaan<textarea name="reason" required minLength={5} rows={3} /></label><p className="ops-muted">SP dicatat untuk review manager dan tidak memicu potongan otomatis.</p></OperationForm></Modal>}
    {modal === "repayment" && <Modal title="Pelunasan kasbon di luar payroll" onClose={() => setModal(null)}><p className="ops-muted">Belum lunas: {rupiah(detail.money.outstanding)}. Gunakan hanya untuk uang yang benar-benar telah diterima.</p><OperationForm action="repayment" data={{ staff_id: staffId }} label="Catat pelunasan" onSaved={() => setModal(null)}><label>Nominal pelunasan (Rp)<input name="amount" type="number" min={1} max={detail.money.outstanding} step={1} required /></label><label>Bukti / alasan<input name="reason" required minLength={5} /></label></OperationForm></Modal>}
    {modal === "payroll" && <Modal title="Proses payroll" description={detail.profile.full_name} onClose={() => setModal(null)} wide><PayrollPanel detail={detail} today={today} includeRules={false} includeHistory={false} /></Modal>}
    {modal === "rules" && <Modal title="Aturan payroll" description="Versi aturan dipilih berdasarkan awal periode payroll. Hasil yang sudah final tetap tersimpan." onClose={() => setModal(null)} wide><RuleForm staffId={staffId} today={today} rule={detail.rules.find(r => r.effective_from <= today)} /><p className="ops-muted">Pajak dan iuran belum dihitung otomatis.</p></Modal>}
  </section>;
}
