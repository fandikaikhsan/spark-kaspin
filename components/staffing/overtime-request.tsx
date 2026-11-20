"use client";
import { useState } from "react";
import { OperationForm } from "./operation-form";
import { TimeChip } from "./time-chip";
import type { OvertimeRequest } from "@/lib/staffing/operations-model";
export function OvertimeRequestDetails({ request, onSaved }: { request: OvertimeRequest; onSaved():void }) {
 const canApprove=request.valid&&request.attendance_confirmed;
 const[decision,setDecision]=useState(canApprove?"approved":"rejected");
 return <><p>{request.full_name} · {request.store_name}</p><dl className="ops-detail-grid"><div className="is-full"><dt>Waktu lembur</dt><dd>{request.intervals.map((item,index)=><p key={index}><TimeChip value={item.starts_at}zone={request.time_zone}/> – <TimeChip value={item.ends_at}zone={request.time_zone}/></p>)}</dd></div><div className="is-full"><dt>Alasan staf</dt><dd>{request.reason}</dd></div></dl>
 {!request.valid&&<p className="ops-error">Absensi / jadwal berubah atau payroll sudah final. Tolak dan minta pengajuan baru.</p>}
 {!request.attendance_confirmed&&<p className="notice">Konfirmasi review absensi terlebih dahulu sebelum menyetujui lembur.</p>}
 <OperationForm action="decide_overtime"data={{request_id:request.id,decision}}label={decision==="approved"?"Setujui lembur":"Tolak pengajuan"}onSaved={onSaved}>
 <label>Keputusan<select value={decision}onChange={event=>setDecision(event.target.value)}><option value="approved"disabled={!canApprove}>Setujui lembur</option><option value="rejected">Tolak</option></select></label><label>Catatan manager{decision==="approved"?" (opsional)":""}<textarea name="note"rows={3}required={decision==="rejected"}minLength={decision==="rejected"?5:undefined}maxLength={1000}/></label>
 </OperationForm></>;
}
