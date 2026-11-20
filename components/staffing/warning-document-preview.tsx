"use client";
import { useEffect, useState } from "react";
import type { WarningDetail } from "@/lib/staffing/warning-model";
export function WarningDocumentPreview({ warning, onUpdated }: { warning: WarningDetail; onUpdated(): void }) {
  const [url,setUrl]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  const [resolution,setResolution]=useState("received"),[reason,setReason]=useState(""),[checked,setChecked]=useState(false);
  const query=`warning=${warning.id}&version=${warning.document_version}`;
  useEffect(()=>{
    const controller=new AbortController();let objectUrl="";setUrl("");setError("");
    fetch(`/api/staffing/warnings/document?${query}`,{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok){const result=await response.json();throw new Error(result.error||"PDF belum dapat dimuat.");}const blob=await response.blob();if(!controller.signal.aborted){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}}).catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:"PDF belum dapat dimuat.");});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[query,retry]);
  async function download(){setBusy(true);setError("");try{
    const response=await fetch(`/api/staffing/warnings/document?${query}&download=1`,{cache:"no-store"});if(!response.ok){const result=await response.json();throw new Error(result.error||"Download gagal.");}
    const blobUrl=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");anchor.href=blobUrl;anchor.download=`${(warning.number||"DRAFT-SP").replaceAll("/","-")}-${warning.staff_code}${warning.status==="revoked"?"-DIBATALKAN":""}.pdf`;anchor.click();setTimeout(()=>URL.revokeObjectURL(blobUrl),3000);onUpdated();
  }catch(err){setError(err instanceof Error?err.message:"Download gagal.");}finally{setBusy(false);}}
  async function send(){setBusy(true);setError("");try{
    const response=await fetch("/api/staffing/warnings/document",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({warning_id:warning.id,recipient_version:warning.recipient_version,document_version:warning.document_version})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Pengiriman gagal.");
  }catch(err){setError(err instanceof Error?err.message:"Pengiriman gagal.");}finally{setBusy(false);onUpdated();}}
  async function verify(){setBusy(true);setError("");try{
    const response=await fetch("/api/staffing/warnings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"resolve_delivery",data:{warning_id:warning.id,document_version:warning.document_version,resolution,reason,acknowledged:checked,client_id:crypto.randomUUID()}})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Verifikasi gagal.");setChecked(false);setReason("");
  }catch(err){setError(err instanceof Error?err.message:"Verifikasi gagal.");}finally{setBusy(false);onUpdated();}}
  const unresolved=warning.delivery_state==="sending"||warning.delivery_state==="uncertain";
  const verifyReady=warning.delivery_state==="uncertain"||(warning.delivery_state==="sending"&&!!warning.delivery_updated_at&&Date.now()-Date.parse(warning.delivery_updated_at)>120000);
  return <section className="ops-warning-pdf"><div className="ops-section-heading"><h3>Pratinjau surat</h3><button type="button" className="ops-secondary" disabled={!url||busy} onClick={download}>{busy?"Memproses…":"Download PDF"}</button></div>
    {error&&<p className="ops-error"role="alert">{error} <button type="button"className="ops-link"disabled={busy}onClick={()=>{setRetry(value=>value+1);onUpdated();}}>Muat ulang</button></p>}
    {!url&&!error?<p role="status"className="ops-muted">Membuat PDF…</p>:url&&<iframe title="Pratinjau surat peringatan"src={url}/>}
    {warning.status!=="draft"&&<div className="ops-warning-recipient"><p>Penerima: <strong>{warning.staff_name} ({warning.staff_code})</strong></p><p className="ops-muted">Hanya chat pribadi akun Telegram staf yang tertaut. {warning.recipient_linked?"Akun tersedia untuk pengiriman.":"Tautkan Telegram dan pastikan staf aktif untuk mengirim."}</p><button type="button"className="ops-telegram-button"disabled={!url||!warning.recipient_linked||busy||warning.delivery_state==="sent"||unresolved}onClick={send}>{warning.delivery_state==="sent"?"PDF sudah dikirim":warning.delivery_state==="sending"?"Pengiriman sedang diproses":warning.status==="revoked"?"Kirim PDF pembatalan ke staf":"Kirim PDF SP ke staf"}</button>
      {unresolved&&<div className="notice"><p>Status kirim perlu diperiksa; sistem tidak mengirim ulang otomatis. Akun staf ditahan dari perubahan sampai status ini jelas.</p><button type="button"className="ops-secondary"disabled={busy}onClick={onUpdated}>Perbarui status kirim</button></div>}
      {verifyReady&&<div className="ops-warning-verification"><h4>Verifikasi status kirim</h4><p className="ops-muted">Gunakan setelah memeriksa chat staf. Hasil verifikasi dan alasannya tercatat pada riwayat.</p><label>Hasil pemeriksaan<select value={resolution}onChange={event=>setResolution(event.target.value)}><option value="received">PDF sudah diterima</option><option value="not_received">PDF belum diterima</option></select></label><label>Catatan verifikasi<textarea value={reason}onChange={event=>setReason(event.target.value)}maxLength={2000}rows={2}/></label><label className="ops-check"><input type="checkbox"checked={checked}onChange={event=>setChecked(event.target.checked)}/>Saya sudah memeriksa chat penerima</label><button type="button"className="ops-secondary"disabled={busy||!checked||reason.trim().length<5}onClick={verify}>Simpan verifikasi</button></div>}
    </div>}
  </section>;
}
