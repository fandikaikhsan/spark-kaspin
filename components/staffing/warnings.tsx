"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./modal";
import { WarningForm } from "./warning-form";
import { WarningTimeline } from "./warning-timeline";
import { WarningDocumentPreview } from "./warning-document-preview";
import { dateTime } from "./record-lists";
import { severityOptions, warningStateLabels, type PointSummary, type WarningDetail, type WarningOverview } from "@/lib/staffing/warning-model";
import { warningHistory } from "@/lib/staffing/warning-history";
import type { StaffDetail } from "@/lib/staffing/operations-model";

function WarningDialog({ id, staff, today, points, onClose, onUpdated }: { id: string; staff: StaffDetail; today: string; points: PointSummary; onClose(): void; onUpdated(): void }) {
  const [doc,setDoc]=useState<WarningDetail|null>(null),[tick,setTick]=useState(0),[error,setError]=useState(""),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false),[ack,setAck]=useState(false),[revoking,setRevoking]=useState(false),[reason,setReason]=useState("");
  const key=useRef<{payload:string;id:string}|null>(null);
  useEffect(()=>{const controller=new AbortController();fetch(`/api/staffing/warnings?warning=${id}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error);if(!controller.signal.aborted)setDoc(result);}).catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:"Surat belum tersedia.");});return()=>controller.abort();},[id,tick]);
  function refresh(){setTick(value=>value+1);onUpdated();}
  async function post(action:string,data:Record<string,unknown>){setBusy(true);setError("");const payload=JSON.stringify({action,data});if(key.current?.payload!==payload)key.current={payload,id:crypto.randomUUID()};try{
    const response=await fetch("/api/staffing/warnings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,data:{...data,client_id:key.current!.id}})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Perubahan belum tersimpan.");key.current=null;setAck(false);setRevoking(false);setReason("");refresh();
  }catch(err){setError(err instanceof Error?err.message:"Perubahan belum tersimpan.");}finally{setBusy(false);}}
  const required: [keyof NonNullable<typeof doc>["data"],string,number][] = [["subject","perihal",5],["letter_date","tanggal surat",1],["incident_date","tanggal kejadian",1],["job_title","jabatan staf",1],["incident_place","tempat kejadian",1],["chronology","kronologi",20],["findings","hasil pemeriksaan",10],["policy_reference","dasar aturan",5],["corrective_actions","tindakan perbaikan",10],["consequences","tindak lanjut",5],["monitoring_start","pembinaan mulai",1],["monitoring_end","pembinaan selesai",1],["issue_city","kota penerbitan",1],["signer_name","nama penerbit",1],["signer_role","jabatan penerbit",1]];
  const missing=doc?required.filter(([field,,min])=>String(doc.data[field]||"").trim().length<min).map(([,label])=>label):[];
  return <Modal title={editing?"Edit draft SP":doc?.number||"Draft surat peringatan"} description={`${staff.profile.full_name} · ${staff.profile.code}`} onClose={onClose} wide>
    {error&&<p className="ops-error"role="alert">{error} <button type="button"className="ops-link"onClick={()=>{setError("");refresh();}}>Muat ulang data</button></p>}
    {!doc?<p className="ops-muted"role="status">Memuat surat…</p>:editing?<WarningForm staff={staff}today={today}warning={doc}onCancel={()=>setEditing(false)}onSaved={()=>{setEditing(false);refresh();}}/>:<>
      <div className="ops-section-heading"><div><span className={`ops-badge is-${doc.status==="issued"?"confirmed":doc.status==="revoked"?"rejected":"pending"}`}>{warningStateLabels[doc.status]}</span><p className="ops-muted">{doc.data.subject||"Perihal belum diisi"}</p></div>{doc.status==="draft"&&<button type="button"className="ops-secondary"disabled={busy}onClick={()=>setEditing(true)}>Edit draft</button>}</div>
      <div className="ops-warning-summary-inline"><span>SP{doc.data.level}</span><span>{severityOptions.find(option=>option.value===doc.data.severity)?.label} · {doc.issued_points??severityOptions.find(option=>option.value===doc.data.severity)?.points} poin</span><span>Pembinaan {doc.data.monitoring_start||"—"} s.d. {doc.data.monitoring_end||"—"}</span></div>
      <WarningDocumentPreview warning={doc}onUpdated={refresh}/>
      {doc.status==="draft"&&<section className="ops-warning-issue"><h3>Terbitkan surat</h3><p>Poin saat ini <strong>{points.balance}</strong> → setelah terbit <strong>{points.balance+(severityOptions.find(option=>option.value===doc.data.severity)?.points||0)}</strong>.</p>
        {!!missing.length&&<p className="notice">Lengkapi draft sebelum diterbitkan: {missing.join(", ")}.</p>}
        <label className="ops-check"><input type="checkbox"checked={ack}disabled={busy}onChange={event=>setAck(event.target.checked)}/>Saya sudah memeriksa fakta, isi surat, tingkat SP, dan bobot poin</label>
        <p className="ops-muted">Nomor dibuat dan poin dibukukan setelah diterbitkan. Surat terbit tidak dapat diedit; pembatalan disimpan sebagai riwayat baru. PDF belum dikirim ke staf sampai tombol kirim ditekan.</p>
        <button type="button"className="ops-button"disabled={busy||!ack||!!missing.length}onClick={()=>post("issue",{warning_id:id,revision:doc.revision,points_version:points.version,acknowledged:ack})}>{busy?"Menerbitkan…":"Terbitkan surat & catat poin"}</button>
      </section>}
      {doc.status==="issued"&&<section className="ops-warning-revoke"><button type="button"className="ops-link"disabled={busy}onClick={()=>setRevoking(value=>!value)}>{revoking?"Tutup pembatalan":"Batalkan surat / koreksi penerbitan"}</button>
        {revoking&&<form className="ops-form"onSubmit={event=>{event.preventDefault();post("revoke",{warning_id:id,revision:doc.revision,points_version:points.version,reason});}}><p className="ops-muted">Surat tetap tersimpan dengan penanda dibatalkan. Saldo saat ini {points.balance}; koreksi poin sebesar {Math.min(points.balance,doc.issued_points||0)} poin. Poin yang sudah dikurangi sebelumnya tidak menjadi kredit negatif.</p><label>Alasan pembatalan<textarea value={reason}required minLength={5}maxLength={2000}rows={2}onChange={event=>setReason(event.target.value)}/></label><button type="submit"className="ops-secondary"disabled={busy||reason.trim().length<5}>Konfirmasi pembatalan</button></form>}
      </section>}
      {doc.status==="revoked"&&<p className="notice">Surat dibatalkan: {doc.revocation_reason}. Salinan PDF terbaru berpenanda DIBATALKAN. Gunakan tombol kirim untuk menyampaikan salinan pembatalan kepada staf.</p>}
      <section className="ops-warning-history-section"><h3>Riwayat surat</h3><WarningTimeline events={doc.events}zone={doc.time_zone}/></section>
    </>}
  </Modal>;
}

function PointAdjustment({ staffId, points, onClose, onSaved }: { staffId:string;points:PointSummary;onClose():void;onSaved():void }) {
  const [amount,setAmount]=useState(String(points.balance)),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const key=useRef<{payload:string;id:string}|null>(null);
  const target=amount.trim()===""?NaN:Number(amount),delta=target-points.balance;
  const valid=Number.isSafeInteger(target)&&target>=0&&target<=1000000&&delta!==0&&reason.trim().length>=5;
  async function submit(event:FormEvent){event.preventDefault();if(!valid)return;setBusy(true);setError("");
    const data={staff_id:staffId,new_balance:target,points_version:points.version,reason};
    const payload=JSON.stringify(data);if(key.current?.payload!==payload)key.current={payload,id:crypto.randomUUID()};
    try {
      const response=await fetch("/api/staffing/warnings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"adjust_points",data:{...data,client_id:key.current.id}})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||"Perubahan belum tersimpan.");onSaved();
    }catch(err){setError(err instanceof Error?err.message:"Perubahan belum tersimpan.");}finally{setBusy(false);}
  }
  return <Modal title="Ubah poin" onClose={onClose}><form className="ops-form"onSubmit={submit}><fieldset disabled={busy}>
    <div className="ops-field-pair"><label>Poin saat ini<input value={`${points.balance} poin`}readOnly/></label><label>Total poin baru<input type="number"min={0}max={1000000}step={1}required autoFocus value={amount}onChange={event=>setAmount(event.target.value)}/></label></div>
    {Number.isSafeInteger(target)&&target>=0&&target<=1000000&&<p className="ops-muted"aria-live="polite">{points.balance} → {target} poin{delta!==0&&` (${delta>0?"+":""}${delta})`}</p>}
    <label>Alasan perubahan<textarea required minLength={5}maxLength={2000}rows={3}value={reason}onChange={event=>setReason(event.target.value)}placeholder="Jelaskan dasar perubahan poin"/></label>
    <div className="ops-form-actions"><button type="button"className="ops-secondary"onClick={onClose}>Batal</button><button type="submit"className="ops-button"disabled={!valid}>{busy?"Menyimpan…":"Simpan perubahan"}</button></div>
  </fieldset>{error&&<p className="ops-error"role="alert">{error}</p>}</form></Modal>;
}

export function Warnings({ staff, today }: { staff:StaffDetail;today:string }) {
  const router=useRouter();
  const[data,setData]=useState<WarningOverview|null>(null),[error,setError]=useState(""),[tick,setTick]=useState(0),[newLetter,setNewLetter]=useState(false),[selected,setSelected]=useState<string|null>(null),[adjusting,setAdjusting]=useState(false),[filter,setFilter]=useState("all"),[query,setQuery]=useState("");
  useEffect(()=>{const controller=new AbortController();setError("");fetch(`/api/staffing/warnings?staff=${staff.profile.id}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error);if(!controller.signal.aborted)setData(result);}).catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:"Data peringatan belum tersedia.");});return()=>controller.abort();},[staff.profile.id,tick]);
  function refresh(){setTick(value=>value+1);router.refresh();}
  if(!data)return <section className="ops-panel">{error?<p className="ops-error"role="alert">{error} <button type="button"className="ops-link"onClick={refresh}>Coba lagi</button></p>:<p className="ops-muted"role="status">Memuat riwayat peringatan…</p>}</section>;
  const drafts=data.warnings.filter(warning=>warning.status==="draft");
  const rows=warningHistory(data).filter(row=>(filter==="all"||(filter==="points"?!row.warning:row.status===filter))&&`${row.kind} ${row.description} ${row.warning?.number||""}`.toLocaleLowerCase("id-ID").includes(query.toLocaleLowerCase("id-ID")));
  function showLetters(status:string){setQuery("");setFilter(filter===status?"all":status);}
  return <div className="ops-warning-page"><section className="ops-panel">
    <div className="ops-section-heading"><h2>Peringatan</h2><div className="ops-action-group"><button type="button"className="ops-secondary"onClick={()=>setAdjusting(true)}>Ubah poin</button><button type="button"className="ops-button"onClick={()=>setNewLetter(true)}>+ Buat surat peringatan</button></div></div>
    <div className="ops-warning-stats">
      <div><span>Total poin</span><strong>{data.points.balance}</strong></div>
      <button type="button"aria-pressed={filter==="issued"}onClick={()=>showLetters("issued")}><span>Surat terbit</span><strong>{data.warnings.filter(warning=>warning.status==="issued").length}</strong></button>
      <button type="button"aria-pressed={filter==="draft"}onClick={()=>{if(drafts.length===1)setSelected(drafts[0].id);else showLetters("draft");}}><span>Draft</span><strong>{drafts.length}</strong></button>
    </div>
    <div className="ops-section-heading"><h3>Riwayat poin & surat</h3><button type="button"className="ops-link"onClick={refresh}>Perbarui</button></div>
    {error&&<p className="ops-error"role="alert">{error}</p>}
    <div className="ops-filterbar ops-warning-filters"><label>Cari riwayat<input value={query}onChange={event=>setQuery(event.target.value)}placeholder="Nomor surat atau keterangan"/></label><label>Tampilkan<select value={filter}onChange={event=>setFilter(event.target.value)}><option value="all">Semua riwayat</option><option value="draft">Draft</option><option value="issued">Surat terbit</option><option value="revoked">Surat dibatalkan</option><option value="points">Poin tanpa surat</option></select></label></div>
    <div className="ops-table-wrap ops-warning-scroll"><table className="ops-table ops-record-table"><thead><tr><th>Tanggal</th><th>Keterangan</th><th>Perubahan</th><th>Total poin</th><th>Surat</th><th>Status</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}className={row.warning?"ops-clickable-row":""}onClick={row.warning?()=>setSelected(row.warning!.id):undefined}>
      <td>{dateTime(row.at,staff.store.time_zone)}</td><td className="ops-description-cell"><strong>{row.kind}</strong><small>{row.description}</small></td>
      <td>{row.change===null?"—":<span className={`ops-badge ${row.change>0?"is-pending":"is-confirmed"}`}>{row.change>0?"+":""}{row.change}</span>}</td><td>{row.balance??"—"}</td>
      <td>{row.warning?<button type="button"className="ops-link"onClick={event=>{event.stopPropagation();setSelected(row.warning!.id);}}>{row.warning.number||`Draft SP${row.warning.level}`}</button>:"—"}</td>
      <td><span className={`ops-badge${row.status==="draft"?" is-pending":row.status==="revoked"?" is-rejected":row.status==="issued"?" is-confirmed":""}`}>{row.status==="recorded"?"Tercatat":warningStateLabels[row.status]}</span></td>
    </tr>)}</tbody></table>{!rows.length&&<p className="ops-empty">Belum ada riwayat yang sesuai.</p>}</div>
  </section>
  {newLetter&&<Modal title="Buat surat peringatan"description={`${staff.profile.full_name} · ${staff.store.name}`}onClose={()=>setNewLetter(false)}wide><WarningForm staff={staff}today={today}onCancel={()=>setNewLetter(false)}onSaved={id=>{setNewLetter(false);setSelected(id);refresh();}}/></Modal>}
  {selected&&<WarningDialog key={selected}id={selected}staff={staff}today={today}points={data.points}onClose={()=>setSelected(null)}onUpdated={refresh}/>}
  {adjusting&&<PointAdjustment staffId={staff.profile.id}points={data.points}onClose={()=>setAdjusting(false)}onSaved={()=>{setAdjusting(false);refresh();}}/>}
  </div>;
}
