import { eventLabels, severityOptions, type WarningEvent } from "@/lib/staffing/warning-model";
import { dateTime } from "./record-lists";
const labels: Record<string,string> = { subject:"Perihal", level:"Tingkat SP", severity:"Bobot", incident_date:"Tanggal kejadian", incident_time:"Jam kejadian", incident_place:"Tempat kejadian", chronology:"Kronologi", findings:"Hasil pemeriksaan", policy_reference:"Dasar peringatan", clarification:"Klarifikasi", corrective_actions:"Tindakan perbaikan", consequences:"Tindak lanjut", sanction_note:"Sanksi tambahan", monitoring_start:"Pembinaan mulai", monitoring_end:"Pembinaan selesai", letter_date:"Tanggal surat", issue_city:"Kota", signer_name:"Nama penerbit", signer_role:"Jabatan penerbit", job_title:"Jabatan staf" };
const display=(key:string,value:unknown)=>key==="severity"?severityOptions.find(option=>option.value===value)?.label||String(value||"—"):key==="level"?`SP${value}`:String(value||"—");
export function WarningTimeline({ events, zone }: { events: WarningEvent[]; zone: string }) {
  if(!events.length)return <p className="ops-empty">Belum ada aktivitas peringatan.</p>;
  return <div className="ops-warning-timeline">{events.map(event => {
    const info=event.details;const before=info.before&&typeof info.before==="object"?info.before as Record<string,unknown>:null;
    const after=info.after&&typeof info.after==="object"?info.after as Record<string,unknown>:null;
    const changes=before&&after?Object.keys(labels).filter(key=>String(before[key]??"")!==String(after[key]??"")):[];
    return <article key={event.id}><div><strong>{eventLabels[event.event]||event.event}</strong><small>{dateTime(event.created_at,zone)} · {event.actor_label}</small></div>
      {typeof info.number==="string"&&<p>{info.number}</p>}
      {typeof info.before==="number"&&typeof info.after==="number"&&<p>{info.before} → {info.after} poin</p>}
      {typeof info.reason==="string"&&<p>{info.reason}</p>}
      {typeof info.recipient_name==="string"&&<p>Penerima: {info.recipient_name} · {String(info.recipient_code||"")}</p>}
      {typeof info.resolution==="string"&&<p>{info.resolution==="received"?"Manager memverifikasi: dokumen diterima":"Manager memverifikasi: dokumen belum diterima"}</p>}
      {!!changes.length&&<details><summary>Rincian perubahan ({changes.length})</summary><dl>{changes.map(key=><div key={key}><dt>{labels[key]}</dt><dd><span>Sebelum: {display(key,before?.[key])}</span><span>Sesudah: {display(key,after?.[key])}</span></dd></div>)}</dl></details>}
    </article>;
  })}</div>;
}
