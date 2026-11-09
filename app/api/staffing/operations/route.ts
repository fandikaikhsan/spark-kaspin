import { operationsRpc, operate, staffId, payrollPreview } from "@/lib/staffing/operations-service";
import { staffingResponse, StaffingError } from "@/lib/staffing/service";
import { validDate } from "@/lib/staffing/operations-model";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{
 const p=new URL(request.url).searchParams;let data;
 switch(p.get("view")){
 case"home":data=await operationsRpc("staffing_home");break;
 case"roster":data=await operationsRpc("staffing_roster");break;
 case"staff":data=await operationsRpc("staffing_staff_detail",{p_staff:staffId(p.get("staff"))});break;
 case"activity":if(p.get("day")&&!validDate(p.get("day")))throw new StaffingError("Tanggal tidak valid.",400);data=await operationsRpc("staffing_activity",{p_store:p.get("store")?staffId(p.get("store")):null,p_day:p.get("day")||null});break;
 case"payroll":data=await payrollPreview(p.get("staff"),p.get("from"),p.get("to"));break;
 default:throw new StaffingError("Halaman tidak tersedia.",404);}
 return Response.json(data,{headers:{"Cache-Control":"no-store"}});
 }catch(error){return staffingResponse(error);}}
export async function POST(request:Request){try{
 const origin=request.headers.get("origin");if((origin&&new URL(origin).host!==new URL(request.url).host)||!request.headers.get("content-type")?.startsWith("application/json"))throw new StaffingError("Invalid request",403);
 const body=await request.json();return Response.json(await operate(body?.action,body?.data),{headers:{"Cache-Control":"no-store"}});
 }catch(error){return staffingResponse(error);}}
