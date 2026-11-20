import { staffingActor, staffingResponse, StaffingError } from "@/lib/staffing/service";
import { operationsRpc, staffId } from "@/lib/staffing/operations-service";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createWarningPdf } from "@/lib/staffing/warning-document";
import { sendWarningDocument } from "@/lib/staffing/warning-delivery";
import type { WarningDocumentData } from "@/lib/staffing/warning-model";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request){try{
 const p=new URL(request.url).searchParams;
 const doc=await operationsRpc<WarningDocumentData>("staffing_warning_document",{p_warning:staffId(p.get("warning"))});
 if(p.get("version")&&p.get("version")!==doc.document_version)throw new StaffingError("Surat berubah. Muat ulang pratinjau.",409);
 const bytes=await createWarningPdf(doc);
 if(p.get("download")==="1")await operationsRpc("staffing_warning_download",{p_warning:doc.id,p_version:doc.document_version});
 const filename=`SP-${doc.staff_code}-${doc.number?doc.number.replaceAll("/","-"):"DRAFT"}${doc.status==="revoked"?"-DIBATALKAN":""}.pdf`;
 return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"application/pdf","Content-Disposition":`${p.get("download")==="1"?"attachment":"inline"}; filename="${filename}"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}catch(error){return staffingResponse(error);}}
export async function POST(request:Request){try{
 const origin=request.headers.get("origin");if((origin&&new URL(origin).host!==new URL(request.url).host)||!request.headers.get("content-type")?.startsWith("application/json"))throw new StaffingError("Invalid request",403);
 const body=await request.json();
 if(!body||typeof body!=="object"||Object.keys(body).some(key=>!["warning_id","recipient_version","document_version"].includes(key))||typeof body.recipient_version!=="string"||!/^[a-f0-9]{32}$/.test(body.recipient_version)||typeof body.document_version!=="string"||!/^[a-f0-9]{32}$/.test(body.document_version))throw new StaffingError("Penerima / versi surat tidak valid.",400);
 return Response.json(await sendWarningDocument(getSupabaseAdmin(),await staffingActor(),staffId(body.warning_id),body.recipient_version,body.document_version),{headers:{"Cache-Control":"no-store"}});
}catch(error){return staffingResponse(error);}}
