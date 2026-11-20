"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { localTime } from "@/lib/staffing/model";
import { storeOffset } from "@/lib/store-timezone";
import { attendanceTimeWarnings } from "@/lib/staffing/attendance-time-warnings";
import type { ReviewedSession } from "@/lib/staffing/operations-model";
import { Modal } from "./modal";
import { TimeChip } from "./time-chip";
type Option = {id:string;staff_id:string;full_name:string;starts_at:string;ends_at:string;version:string};
type Evidence = {attempt_id:string;kind:string;latitude:number;longitude:number;effective_at:string};
export function UnplannedAttendance({session}:{session:ReviewedSession}) {
 const router=useRouter(),reviewKey=useRef<string|null>(null),resolveKey=useRef<string|null>(null);
 const enteredInitial=localTime(session.corrected_in_at||session.check_in_at,session.time_zone,true);
 const exitedInitial=session.corrected_out_at||session.check_out_at;
 const exitedLocal=exitedInitial?localTime(exitedInitial,session.time_zone,true):"";
 const[entered,setEntered]=useState(enteredInitial),[exited,setExited]=useState(exitedLocal),[state,setState]=useState(session.verification_state),[note,setNote]=useState(session.review_note||"");
 const[busy,setBusy]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState(false),[confirm,setConfirm]=useState(false),[editing,setEditing]=useState(false);
 const[evidence,setEvidence]=useState<Evidence[]>([]),[evidenceError,setEvidenceError]=useState(""),[options,setOptions]=useState<Option[]>([]),[loading,setLoading]=useState(true);
 const[mode,setMode]=useState(""),[starts,setStarts]=useState(enteredInitial.slice(0,16)),[ends,setEnds]=useState(exitedLocal.slice(0,16)),[reason,setReason]=useState("");
 const[person,setPerson]=useState(""),[target,setTarget]=useState(""),[own,setOwn]=useState("");
 const offset=storeOffset(session.time_zone),locked=!!session.payroll_locked;
 const warnings=attendanceTimeWarnings(entered+offset,exited?exited+offset:null,new Date());
 const valid=!!entered&&(!session.check_out_at||!!exited);
 const dirty=entered!==enteredInitial||exited!==exitedLocal||state!==session.verification_state||note.trim()!==(session.review_note||"").trim();
 useEffect(()=>{setEntered(enteredInitial);setExited(exitedLocal);setState(session.verification_state);setNote(session.review_note||"");setStarts(enteredInitial.slice(0,16));setEnds(exitedLocal.slice(0,16));setMode("");setTarget("");setOwn("");setPerson("");setSaved(false);reviewKey.current=null;resolveKey.current=null;},[session.review_version,enteredInitial,exitedLocal,session.verification_state,session.review_note]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);
  Promise.all([
   fetch(`/api/staffing/evidence?session=${session.id}`,{signal:controller.signal,cache:"no-store"}).then(async r=>{const value=await r.json();if(!r.ok&&r.status!==404)throw new Error("Bukti belum dapat dimuat.");return r.ok?value:[];}),
   fetch(`/api/staffing/operations?view=unplanned_context&session=${session.id}`,{signal:controller.signal,cache:"no-store"}).then(async r=>{const value=await r.json();if(!r.ok)throw new Error(value.error||"Pilihan jadwal belum dapat dimuat.");return value.options as Option[];})
  ]).then(([proof,schedules])=>{if(!controller.signal.aborted){setEvidence([...proof].sort((a:Evidence,b:Evidence)=>a.kind===b.kind?0:a.kind==="check_in"?-1:1));setOptions(schedules);}}).catch(e=>{if(!controller.signal.aborted)setEvidenceError(e instanceof Error?e.message:"Data belum dapat dimuat.");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[session.id,session.review_version]);
 function change(){setSaved(false);setError("");reviewKey.current=null;}
 async function post(action:string,data:Record<string,unknown>){
  const response=await fetch("/api/staffing/operations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,data})});
  const result=await response.json();if(!response.ok){if(response.status===409)router.refresh();throw new Error(result.error||"Perubahan belum dapat disimpan.");}return result;
 }
 async function saveReview(ack=false){
  if(busy||locked||!valid||!dirty)return;setBusy(true);setError("");reviewKey.current??=crypto.randomUUID();
  try{await post("review_unplanned",{session_id:session.id,version:session.review_version,client_id:reviewKey.current,state,note:note.trim(),correct_times:entered!==enteredInitial||exited!==exitedLocal,check_in_local:entered,check_out_local:exited,acknowledge_time_anomalies:ack});setSaved(true);router.refresh();}
  catch(e){setError(e instanceof Error?e.message:"Review belum tersimpan.");}finally{setBusy(false);setConfirm(false);}
 }
 function submitReview(e:FormEvent){e.preventDefault();if(state==="confirmed")setConfirm(true);else void saveReview();}
 async function resolve(e:FormEvent){
  e.preventDefault();if(busy||locked||!mode)return;setBusy(true);setError("");resolveKey.current??=crypto.randomUUID();
  const chosen=options.find(s=>s.id===target),ownShift=options.find(s=>s.id===own);
  try{await post("resolve_unplanned",{session_id:session.id,version:session.review_version,client_id:resolveKey.current,mode,starts_local:starts,ends_local:ends,note:reason.trim(),target_shift_id:target||null,target_version:chosen?.version,own_shift_id:own||null,own_version:ownShift?.version});setSaved(true);setMode("");router.refresh();}
  catch(e){setError(e instanceof Error?e.message:"Penanganan belum tersimpan.");}finally{setBusy(false);}
 }
 const people=[...new Map(options.filter(s=>s.staff_id!==session.staff_id).map(s=>[s.staff_id,{id:s.staff_id,name:s.full_name}])).values()];
 const format=(value:string)=>{const[day,time]=localTime(value,session.time_zone).split("T");const[y,m,d]=day.split("-");return `${d}/${m}/${y} ${time}`;};
 const range=(s:Option)=>`${format(s.starts_at)} – ${format(s.ends_at)}`;
 return <div className="ops-unplanned-review">
  <p className="ops-attendance-chips"><span className="ops-badge is-pending">Masuk di luar jadwal</span>{(session.shared_evidence_count||0)>1&&<span className="ops-badge">Bukti bersama {session.shared_evidence_count} staf</span>}</p><p className="ops-muted">{session.outside_reason}. Tentukan jadwal atau lembur untuk menghubungkan absensi ini ke payroll.</p>
  <form className="ops-review-form" onSubmit={submitReview}><fieldset disabled={busy||locked}>
   <section className="ops-review-times"><div className="ops-section-heading"><h3>Waktu absensi</h3><button type="button" className="ops-secondary" onClick={()=>setEditing(v=>!v)}>{editing?"Selesai edit":"Edit waktu"}</button></div>
    <div className="ops-review-time-grid"><div><span>Masuk tercatat</span>{editing?<input type="datetime-local" step={1} required value={entered} aria-label="Waktu masuk aktual" onChange={e=>{setEntered(e.target.value);change();}}/>:<TimeChip value={session.corrected_in_at||session.check_in_at} zone={session.time_zone}/>}</div><div><span>Pulang tercatat</span>{editing?<input type="datetime-local" step={1} required={!!session.check_out_at} value={exited} aria-label="Waktu pulang aktual" onChange={e=>{setExited(e.target.value);change();}}/>:exitedInitial?<TimeChip value={exitedInitial} zone={session.time_zone}/>:<strong>Belum checkout</strong>}</div></div>
    {warnings.length>0&&<div className="ops-error" role="alert">{warnings.map(w=><p key={w}>{w}</p>)}</div>}
    <p className="ops-muted">Pelapor masuk: {session.check_in_reporter_name||session.full_name}{exitedInitial?` · Pelapor pulang: ${session.check_out_reporter_name||session.full_name}`:""}</p>
   </section>
   <section className="ops-review-evidence"><h3>Bukti absensi</h3>{loading?<p role="status">Memuat bukti…</p>:evidenceError?<p className="ops-error">{evidenceError}</p>:<div className="ops-evidence-grid">{evidence.map(item=><article key={item.attempt_id}><span className="ops-eyebrow">Bukti {item.kind==="check_in"?"masuk":"pulang"}</span><Image unoptimized src={`/api/staffing/evidence?attempt=${item.attempt_id}`} alt="Foto bukti kehadiran" width={360} height={200}/><p>{item.latitude}, {item.longitude}</p><p className="ops-muted">{localTime(item.effective_at,session.time_zone).replace("T"," ")}</p><a className="ops-inline-link" href={`https://www.google.com/maps?q=${item.latitude},${item.longitude}`} target="_blank" rel="noreferrer">Buka peta eksternal ↗</a></article>)}</div>}</section>
   <section className="ops-review-decision"><h3>Review manager</h3><div className="ops-review-fields"><label>Status review<select value={state} onChange={e=>{setState(e.target.value as typeof state);change();}}><option value="pending">Menunggu review</option><option value="confirmed">Konfirmasi absensi</option><option value="rejected">Tolak absensi</option></select></label><label>Catatan review (opsional)<textarea maxLength={1000} value={note} onChange={e=>{setNote(e.target.value);change();}}/></label></div></section>
  </fieldset><footer className="ops-review-footer"><span>{locked?"Payroll sudah final":saved?"Review tersimpan":dirty?"Perubahan belum disimpan":"Belum ada perubahan"}</span><button className="ops-button" disabled={busy||locked||!dirty||!valid}>Simpan review</button></footer></form>
  <section className="ops-panel"><h3>Penanganan jadwal</h3><p className="ops-muted">Simpan review dan koreksi waktu sebelum memilih penanganan. Lembur memerlukan absensi terkonfirmasi dan catatan pulang.</p>
   <div className="ops-action-group">{[["schedule","Tambah jadwal"],["overtime","Tambahkan ke lembur"],["replace","Tukar jadwal"]].map(([value,label])=><button key={value} type="button" className="ops-secondary" disabled={busy||locked||dirty||session.verification_state==="rejected"} onClick={()=>{setMode(value);setError("");resolveKey.current=null;}}>{label}</button>)}</div>
   {mode&&<form className="ops-form" onSubmit={resolve} onChange={()=>{resolveKey.current=null;setError("");}}><fieldset disabled={busy||locked}>
    {mode==="schedule"&&<div className="ops-field-pair"><label>Mulai jadwal<input type="datetime-local" required value={starts} onChange={e=>setStarts(e.target.value)}/></label><label>Selesai jadwal<input type="datetime-local" required value={ends} onChange={e=>setEnds(e.target.value)}/></label></div>}
    {mode==="overtime"&&<p>Seluruh waktu aktual masuk–pulang akan dicatat sebagai lembur yang disetujui manager.</p>}
    {["replace","swap"].includes(mode)&&<><fieldset><legend>Penanganan jadwal</legend><label className="ops-check"><input type="radio" name="shift-handling" checked={mode==="replace"} onChange={()=>setMode("replace")}/>Menggantikan shift rekan</label><label className="ops-check"><input type="radio" name="shift-handling" checked={mode==="swap"} onChange={()=>setMode("swap")}/>Tukar dua shift</label></fieldset><label>Rekan<select required value={person} onChange={e=>{setPerson(e.target.value);setTarget("");}}><option value="">Pilih rekan</option>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Shift rekan<select required value={target} onChange={e=>setTarget(e.target.value)}><option value="">Pilih jadwal</option>{options.filter(s=>s.staff_id===person).map(s=><option key={s.id} value={s.id}>{range(s)}</option>)}</select></label>{mode==="swap"&&<label>Shift milik {session.full_name}<select required value={own} onChange={e=>setOwn(e.target.value)}><option value="">Pilih shift yang diberikan ke rekan</option>{options.filter(s=>s.staff_id===session.staff_id).map(s=><option key={s.id} value={s.id}>{range(s)}</option>)}</select></label>}<small>Pilihan menampilkan jadwal tanpa absensi pada 7 hari sebelum/sesudah catatan masuk. Perubahan jadwal langsung dicatat sebagai keputusan manager.</small></>}
    <label>{mode==="overtime"?"Alasan lembur":"Catatan penanganan (opsional)"}<textarea required={mode==="overtime"} minLength={mode==="overtime"?5:undefined} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <div className="ops-action-group"><button className="ops-button">Simpan penanganan</button><button type="button" className="ops-secondary" onClick={()=>setMode("")}>Batal</button></div>
   </fieldset></form>}
  </section>
  {error&&<p className="ops-error" role="alert">{error}</p>}
  {confirm&&<Modal title="Konfirmasi absensi di luar jadwal?" description={session.full_name} onClose={()=>{if(!busy)setConfirm(false);}}>{warnings.length>0&&<div className="ops-error">{warnings.map(w=><p key={w}>{w}</p>)}</div>}<p>Konfirmasi menerima waktu yang tercatat. Pilih penanganan jadwal setelah review agar absensi dapat dihitung dalam payroll.</p><div className="ops-action-group"><button type="button" className="ops-secondary" disabled={busy} autoFocus onClick={()=>setConfirm(false)}>Kembali periksa</button><button type="button" className="ops-button" disabled={busy} onClick={()=>void saveReview(warnings.length>0)}>Ya, terima absensi</button></div></Modal>}
 </div>;
}
