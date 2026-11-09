import { localTime, storeInstant } from "./model";
import { addDays } from "./schedule";
import type { PayrollInput, PayrollResult } from "./operations-model";

const seconds = (date: string) => Math.floor(Date.parse(date) / 1000);
const roundRatio = (numerator: bigint, denominator: bigint) => Number((numerator + denominator / 2n) / denominator);
const inside = (mid: number, from: string, to: string) => mid >= seconds(from) && mid < seconds(to);

// Money is accumulated as integer rupiah*seconds and rounded only per component.
// A manager-confirmed review can approve actual time outside the schedule.
// Existing explicit overtime intervals remain supported for historical records.
export function calculatePayroll(input: PayrollInput, now = new Date()): PayrollResult {
  const result: PayrollResult = { normal_pay:0,night_pay:0,overtime_pay:0,paid_leave_pay:0,sick_pay:0,bonuses:0,gross_pay:0,late_penalties:0,frequency_penalty:0,deductions:0,loan_repayment:0,net_pay:0,normal_hours:0,night_hours:0,overtime_hours:0,late_count:0,blockers:[],notes:["Jam dibayar berdasarkan absensi terkonfirmasi, jadwal, dan lembur yang disetujui melalui review waktu aktual. Istirahat hanya dikurangi bila interval tanpa upah dicatat.","Pembulatan rupiah dilakukan per komponen. Potongan kasbon dibatasi penghasilan bersih tersedia dan plafon potongan per payroll."],lines:[] };
  const rule=input.rule;
  if(!rule){result.blockers.push("Aturan tarif belum diatur untuk awal periode ini.");return result;}
  if(input.rule_changes.length)result.blockers.push("Aturan berubah di tengah periode. Pisahkan periode pada tanggal perubahan aturan.");
  if(input.posted.length)result.blockers.push("Periode bertabrakan dengan payroll yang sudah final.");
  if(input.period_end>=localTime(now.toISOString(),input.time_zone).slice(0,10))result.blockers.push("Periode belum berakhir; hasil ini masih preview.");
  const periodStart=seconds(input.range_start),periodEnd=seconds(input.range_end);
  let normal=0n,night=0n,overtime=0n,normalSeconds=0,nightSeconds=0,otSeconds=0;
  const paidByDay=new Map<string,number>();
  const activeRanges: [number,number][]=[];
  for(const session of input.sessions){
    if(session.verification_state==="rejected")continue;
    if(session.verification_state!=="confirmed"){result.blockers.push(`Absensi ${session.label} belum dikonfirmasi manager.`);continue;}
    const effectiveIn=session.corrected_in_at||session.check_in_at;
    const effectiveOut=session.corrected_out_at||session.check_out_at;
    if(!effectiveOut){result.blockers.push(`Sesi ${session.label} belum memiliki checkout.`);continue;}
    const from=Math.max(periodStart,seconds(effectiveIn)),to=Math.min(periodEnd,seconds(effectiveOut));
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)continue;
    if(to>Math.floor(now.getTime()/1000))result.blockers.push("Ada waktu absensi di masa depan.");
    if(activeRanges.some(([a,b])=>from<b&&to>a))result.blockers.push("Jam aktual antar-sesi bertabrakan. Koreksi sebelum finalisasi.");
    activeRanges.push([from,to]);
    const approvals=input.time_approvals.filter(a=>a.session_id===session.id);
    const points=new Set([from,to,seconds(session.starts_at),seconds(session.ends_at)]);
    for(const a of approvals){points.add(seconds(a.starts_at));points.add(seconds(a.ends_at));}
    // Split at both work-store night boundaries and the payroll-home midnight.
    for(const zone of new Set([session.time_zone,input.time_zone])){
      let day=localTime(new Date(from*1000).toISOString(),zone).slice(0,10);
      const last=localTime(new Date(to*1000).toISOString(),zone).slice(0,10);
      for(let n=0;n<65&&day<=last;n++,day=addDays(day,1)){
        points.add(seconds(storeInstant(day+"T00:00",zone)));
        points.add(seconds(storeInstant(addDays(day,1)+"T00:00",zone)));
        if(zone===session.time_zone&&rule.night_enabled){points.add(seconds(storeInstant(`${day}T${rule.night_start.slice(0,5)}`,zone)));points.add(seconds(storeInstant(`${day}T${rule.night_end.slice(0,5)}`,zone)));}
      }
    }
    const cuts=[...points].filter(p=>p>=from&&p<=to).sort((a,b)=>a-b);
    let lineNormal=0,lineNight=0,lineOt=0;
    for(let i=0;i<cuts.length-1;i++){
      const a=cuts[i],b=cuts[i+1],mid=(a+b)/2,duration=b-a;
      if(approvals.some(x=>x.kind==="unpaid_break"&&inside(mid,x.starts_at,x.ends_at)))continue;
      const scheduled=inside(mid,session.starts_at,session.ends_at);
      const ot=(!scheduled&&session.overtime_from_attendance===true)||approvals.some(x=>x.kind==="overtime"&&inside(mid,x.starts_at,x.ends_at));
      if(!scheduled&&!ot)continue;
      const clock=localTime(new Date(mid*1000).toISOString(),session.time_zone).slice(11,16);
      const start=rule.night_start.slice(0,5),end=rule.night_end.slice(0,5);
      const isNight=rule.night_enabled&&(start>end?(clock>=start||clock<end):(clock>=start&&clock<end));
      const rate=BigInt(isNight?rule.night_rate!:rule.normal_rate);
      if(scheduled){if(isNight){night+=rate*BigInt(duration);lineNight+=duration;}else{normal+=rate*BigInt(duration);lineNormal+=duration;}}
      if(ot){overtime+=rate*BigInt(duration)*BigInt(scheduled?rule.overtime_percent-100:rule.overtime_percent);lineOt+=duration;}
      const homeDay=localTime(new Date(mid*1000).toISOString(),input.time_zone).slice(0,10);
      paidByDay.set(homeDay,(paidByDay.get(homeDay)||0)+duration);
    }
    const scheduledStart=seconds(session.starts_at);
    const lateMinutes=Math.max(0,Math.ceil((seconds(effectiveIn)-scheduledStart)/60));
    if(scheduledStart>=periodStart&&scheduledStart<periodEnd&&lateMinutes>0){
      result.late_count++;
      if(rule.late_enabled){const tier=rule.late_tiers.find(t=>lateMinutes<=t.minutes)||rule.late_tiers[rule.late_tiers.length-1];result.late_penalties+=tier?.amount||0;}
    }
    normalSeconds+=lineNormal;nightSeconds+=lineNight;otSeconds+=lineOt;
    result.lines.push({session_id:session.id,normal_hours:lineNormal/3600,night_hours:lineNight/3600,overtime_hours:lineOt/3600,late_minutes:lateMinutes});
  }
  result.normal_pay=roundRatio(normal,3600n);result.night_pay=roundRatio(night,3600n);result.overtime_pay=roundRatio(overtime,360000n);
  result.normal_hours=normalSeconds/3600;result.night_hours=nightSeconds/3600;result.overtime_hours=otSeconds/3600;
  const leaveUnits=new Map<string,number>();let paidLeaveUnits=0,sickUnits=0;
  for(const request of input.leave){
    const payment=request.payment_mode??(request.kind==="paid_leave"?"leave":request.kind==="sick"?"sick":"none");
    for(const date of request.leave_dates){
      if(date.date<input.period_start||date.date>input.period_end)continue;
      if(payment==="leave"||payment==="sick"){
        leaveUnits.set(date.date,(leaveUnits.get(date.date)||0)+Number(date.units));
        if(payment==="leave")paidLeaveUnits+=Number(date.units);else sickUnits+=Number(date.units);
      }
    }
  }
  if(paidLeaveUnits&&rule.leave_day_rate===null)result.blockers.push("Isi tarif harian izin berbayar sebelum menghitungnya.");
  if(sickUnits&&rule.sick_day_rate===null)result.blockers.push("Isi tarif harian sakit yang telah disepakati.");
  for(const[day,units]of leaveUnits){if((paidByDay.get(day)||0)+units*Number(rule.day_hours)*3600>Number(rule.day_hours)*3600+1)result.blockers.push(`Jam kerja dan izin berbayar bertabrakan pada ${day}.`);}
  result.paid_leave_pay=Math.round(paidLeaveUnits*(rule.leave_day_rate||0));result.sick_pay=Math.round(sickUnits*(rule.sick_day_rate||0));
  result.bonuses=input.bonuses.reduce((sum,b)=>sum+Number(b.amount),0);
  result.gross_pay=result.normal_pay+result.night_pay+result.overtime_pay+result.paid_leave_pay+result.sick_pay+result.bonuses;
  if(rule.frequency_enabled){const tier=[...rule.frequency_tiers].reverse().find(t=>result.late_count>=t.count);result.frequency_penalty=tier?.amount||0;}
  result.deductions=result.late_penalties+result.frequency_penalty;
  const available=result.gross_pay-result.deductions;
  if(available<0)result.blockers.push("Potongan melebihi penghasilan. Tinjau aturan sebelum finalisasi.");
  result.loan_repayment=Math.min(Number(input.outstanding),Math.max(0,available),rule.loan_repayment_cap===null?Number.MAX_SAFE_INTEGER:Number(rule.loan_repayment_cap));
  result.net_pay=Math.max(0,available-result.loan_repayment);
  result.blockers=[...new Set(result.blockers)];
  return result;
}
