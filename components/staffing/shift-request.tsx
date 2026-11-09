"use client";
import { useState } from "react";
import type { ShiftChangeRequest } from "@/lib/staffing/operations-model";
import { OperationForm } from "./operation-form";
import { TimeChip } from "./time-chip";
export function ShiftRequestDetails({ request, onSaved }: { request: ShiftChangeRequest; onSaved: () => void }) {
 const [decision,setDecision]=useState(request.valid?"approved":"rejected");
 return <><p className="ops-muted">Pihak kedua sudah menyatakan bersedia melalui akun Telegram yang tertaut. Jadwal baru berubah setelah persetujuan manager.</p>
  <dl className="ops-detail-grid"><div><dt>Jenis</dt><dd>{request.mode==="swap"?"Tukar dua shift":"Penggantian shift"}</dd></div><div><dt>Store</dt><dd>{request.store_name}</dd></div>
  <div className="is-full"><dt>Penugasan pertama</dt><dd><strong>{request.requester_name} → {request.target_name}</strong><p className="ops-review-range"><TimeChip value={request.shift_snapshot.starts_at} zone={request.time_zone}/> – <TimeChip value={request.shift_snapshot.ends_at} zone={request.time_zone}/></p></dd></div>
  {request.other_snapshot&&<div className="is-full"><dt>Penugasan balasan</dt><dd><strong>{request.target_name} → {request.requester_name}</strong><p className="ops-review-range"><TimeChip value={request.other_snapshot.starts_at} zone={request.time_zone}/> – <TimeChip value={request.other_snapshot.ends_at} zone={request.time_zone}/></p></dd></div>}
  <div className="is-full"><dt>Batas persetujuan</dt><dd><TimeChip value={request.expires_at} zone={request.time_zone}/></dd></div></dl>
  {!request.valid&&<p className="ops-error">Jadwal sudah berubah atau terkunci. Tolak permintaan ini dan minta staff membuat permintaan baru.</p>}
  <OperationForm action="decide_shift" data={{request_id:request.id,decision}} label={decision==="approved"?"Setujui & perbarui jadwal":"Tolak permintaan"} onSaved={onSaved}>
   <label>Keputusan<select value={decision} onChange={event=>setDecision(event.target.value)}><option value="approved" disabled={!request.valid}>Setujui perubahan jadwal</option><option value="rejected">Tolak permintaan</option></select></label>
   <label>Catatan pemeriksaan<textarea name="note" rows={3} required minLength={5} maxLength={1000} placeholder="Periksa bentrok, jeda istirahat, total jam dan coverage sebelum menyetujui."/></label>
  </OperationForm>
 </>;
}
