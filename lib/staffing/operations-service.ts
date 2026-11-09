import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { staffingActor, StaffingError } from "./service";
import { calculatePayroll } from "./payroll";
import { validDate, type PayrollInput, type PayrollResult } from "./operations-model";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function staffId(value:unknown):string {if(typeof value!=="string"||!uuid.test(value))throw new StaffingError("Identitas tidak valid.",400);return value;}
export async function operationsRpc<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
 const {data,error}=await getSupabaseAdmin().rpc(name,{...await staffingActor(),...args});
 if(error){if(error.message.includes("FORBIDDEN"))throw new StaffingError("Access denied",403);if(error.message.includes("REQUEST_STALE"))throw new StaffingError("Pengajuan berubah sejak dibuka. Tutup dan buka kembali detail sebelum mengedit.",409);if(error.message.includes("ATTENDANCE_STALE"))throw new StaffingError("Absensi berubah sejak modal dibuka. Tutup dan buka kembali sebelum menyimpan.",409);if(error.message.includes("PAYROLL_STALE"))throw new StaffingError("Data payroll berubah. Hitung ulang preview sebelum finalisasi.",409);if(["PGRST202","42P01","42703","42883"].includes(error.code||""))throw new StaffingError("Fitur belum diaktifkan. Hubungi administrator.",503);if(error.code==="P0001")throw new StaffingError(error.message,400);if(error.code==="23505")throw new StaffingError("Data sudah tercatat.",409);throw new StaffingError("Periksa data dan coba kembali.",400);}return data as T;
}
function period(from:unknown,to:unknown){if(!validDate(from)||!validDate(to)||to<from||(Date.parse(to)-Date.parse(from))/86400000>61)throw new StaffingError("Pilih periode valid, maksimal 62 hari.",400);return{from,to};}
export async function payrollPreview(id:unknown,from:unknown,to:unknown){const dates=period(from,to);const source=await operationsRpc<{input:PayrollInput;version:string}>("staffing_payroll_source",{p_staff:staffId(id),p_from:dates.from,p_to:dates.to});return{version:source.version,result:calculatePayroll(source.input),rule:source.input.rule,period_start:dates.from,period_end:dates.to};}
const actions=new Set(["profile","leave_adjustment","request","approve_request","reject_request","cancel_request","disburse","repayment","bonus","discipline","attendance_review","overtime","unpaid_break","payroll_rule"]);
export async function operate(action:unknown,input:unknown){
 if(typeof action!=="string"||!input||typeof input!=="object"||Array.isArray(input))throw new StaffingError("Pengajuan tidak valid.",400);
 const data={...input}as Record<string,unknown>;
 if(action==="amend_request"){
  staffId(data.request_id);staffId(data.client_id);
  if(!Number.isSafeInteger(data.revision)||Number(data.revision)<0)throw new StaffingError("Versi pengajuan tidak valid.",400);
  if(data.amount===undefined){
   period(data.start_date,data.end_date);
   if(!Array.isArray(data.leave_dates)||data.leave_dates.length<1||data.leave_dates.length>62)throw new StaffingError("Pilih tanggal izin yang dihitung.",400);
  }
  return operationsRpc("staffing_amend_request",{p_data:data});
 }
 if(action==="decide_shift"){
  const result=await operationsRpc<{id:string;status:string}>("staffing_decide_shift",{p_request:staffId(data.request_id),p_decision:data.decision,p_note:data.note});
  if(result.status==="stale"||result.status==="expired")throw new StaffingError("Permintaan tidak berlaku karena jadwal berubah, terkunci atau kedaluwarsa. Muat ulang Activities.",409);
  return result;
 }
 if(action==="review_attendance"){
  staffId(data.session_id);staffId(data.client_id);
  data.correct_times=data.correct_times===true;
  if(data.correct_times){
   const context=await operationsRpc<{time_zone:string}>("staffing_session_context",{p_session:data.session_id});
   const {storeInstant}=await import("./model");
   try{data.check_in_at=storeInstant(data.check_in_local,context.time_zone);data.check_out_at=data.check_out_local?storeInstant(data.check_out_local,context.time_zone):null;}catch{throw new StaffingError("Isi waktu absensi sesuai timezone store.",400);}
  }
  return operationsRpc("staffing_review_attendance",{p_data:data});
 }
 if(action==="create_staff"){
  staffId(data.home_store_id);staffId(data.client_id);
  return operationsRpc("staffing_create_staff",{p_data:data});
 }
 if(action==="finalize_payroll"){
  const dates=period(data.from,data.to);const id=staffId(data.staff_id);
  const source=await operationsRpc<{input:PayrollInput;version:string}>("staffing_payroll_source",{p_staff:id,p_from:dates.from,p_to:dates.to});
  const already=source.input.posted.some(p=>p.period_start===dates.from&&p.period_end===dates.to);
  if(!already&&source.version!==data.version)throw new StaffingError("Data berubah. Hitung ulang preview.",409);
  const result=calculatePayroll(source.input);
  if(!already&&result.blockers.length)throw new StaffingError(result.blockers.join(" "),400);
  return operationsRpc("staffing_finalize_payroll",{p_staff:id,p_from:dates.from,p_to:dates.to,p_version:source.version,p_result:result});
 }
 if(!actions.has(action))throw new StaffingError("Aksi tidak tersedia.",400);
 for(const key of["staff_id","session_id","request_id"])if(data[key]!==undefined)staffId(data[key]);
 for(const key of["active","night_enabled","late_enabled","frequency_enabled"])if(action==="profile"||action==="payroll_rule")data[key]=data[key]===true||data[key]==="on"||data[key]==="true";
 if(action==="request"&&data.kind!=="cash_advance"){
  if(!validDate(data.start_date)||!validDate(data.end_date))throw new StaffingError("Tanggal izin tidak valid.",400);
  if(typeof data.leave_dates==="string"){try{data.leave_dates=JSON.parse(data.leave_dates);}catch{throw new StaffingError("Pilih tanggal izin.",400);}}
 }
 if(action==="payroll_rule"){
  if(!validDate(data.effective_from))throw new StaffingError("Tanggal berlaku aturan wajib diisi.",400);
  for(const name of["late_tiers","frequency_tiers"])if(typeof data[name]==="string"){try{data[name]=JSON.parse(data[name]);}catch{throw new StaffingError("Tabel penalti tidak valid.",400);}}
  for(const [name,threshold] of [["late_tiers","minutes"],["frequency_tiers","count"]]){
   const rows=data[name];if(!Array.isArray(rows)||rows.length>20||rows.some(row=>!row||!Number.isSafeInteger(row.amount)||row.amount<0||row.amount>1000000000||!Number.isSafeInteger(row[threshold])||row[threshold]<1||row[threshold]>100000))throw new StaffingError("Tabel penalti harus berupa bilangan bulat yang valid, maksimal 20 baris.",400);
  }
  for(const name of["normal_rate","night_rate","leave_day_rate","sick_day_rate","loan_repayment_cap"]){if(data[name]!==""&&data[name]!==null&&data[name]!==undefined&&!Number.isSafeInteger(Number(data[name])))throw new StaffingError("Nominal harus berupa rupiah bulat.",400);}
 }
 if(action==="overtime"||action==="unpaid_break"){
  const context=await operationsRpc<{time_zone:string}>("staffing_session_context",{p_session:data.session_id});
  const {storeInstant}=await import("./model");
  try{data.starts_at=storeInstant(data.starts_local,context.time_zone);data.ends_at=storeInstant(data.ends_local,context.time_zone);}catch{throw new StaffingError("Isi waktu persetujuan sesuai timezone store.",400);}
 }
 return operationsRpc("staffing_operations",{p_action:action,p_data:data});
}
export type PayrollPreview=Awaited<ReturnType<typeof payrollPreview>>;
export type { PayrollResult };
