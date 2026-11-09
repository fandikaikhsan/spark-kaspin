import{createSchedulePdf}from"@/lib/staffing/schedule-document";
import{operationsRpc,staffId}from"@/lib/staffing/operations-service";
import{validMonday,type ScheduleWeek}from"@/lib/staffing/schedule";
import{staffingResponse,StaffingError}from"@/lib/staffing/service";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const p=new URL(request.url).searchParams;const week=p.get('week');if(!week||!validMonday(week))throw new StaffingError('Minggu tidak valid.',400);const data=await operationsRpc<ScheduleWeek>('staffing_schedule_week',{p_store:staffId(p.get('store')),p_week:week});const bytes=await createSchedulePdf(data);return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="jadwal-${week}.pdf"`,'Cache-Control':'no-store'}});}catch(error){return staffingResponse(error);}}
