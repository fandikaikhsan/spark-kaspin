import { staffingActor, staffingResponse, StaffingError } from "@/lib/staffing/service";
import { operationsRpc, payrollPreview, staffId } from "@/lib/staffing/operations-service";
import { createPayrollPdf, type PayrollDocumentData } from "@/lib/staffing/payroll-document";
import { sendPayrollDocument } from "@/lib/staffing/payroll-delivery";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { StaffDetail } from "@/lib/staffing/operations-model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams; let document: PayrollDocumentData;
    if (p.has("payroll")) {
      const context = await operationsRpc<PayrollDocumentData & { recipient_linked: boolean; recipient_version: string; delivery_state: string | null }>("staffing_payroll_document", { p_payroll: staffId(p.get("payroll")) });
      if (p.get("format") === "metadata") return Response.json({ staff_name: context.staff_name, staff_code: context.staff_code, recipient_linked: context.recipient_linked, recipient_version: context.recipient_version, delivery_state: context.delivery_state }, { headers: { "Cache-Control": "no-store" } });
      document = context;
    } else {
      const id = staffId(p.get("staff")), preview = await payrollPreview(id, p.get("from"), p.get("to"));
      if (p.get("version") !== preview.version) throw new StaffingError("Data payroll berubah. Hitung ulang preview PDF.", 409);
      const detail = await operationsRpc<StaffDetail>("staffing_staff_detail", { p_staff: id });
      document = { id: "DRAFT", staff_name: detail.profile.full_name, staff_code: detail.profile.code, store_name: detail.store.name, time_zone: detail.store.time_zone, period_start: preview.period_start, period_end: preview.period_end, created_at: new Date().toISOString(), result: preview.result, final: false };
    }
    const bytes = await createPayrollPdf(document);
    const name = `payroll-${document.staff_code}-${document.period_start}${document.final ? "" : "-DRAFT"}.pdf`;
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `${p.get("download") === "1" ? "attachment" : "inline"}; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return staffingResponse(error); }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if ((origin && new URL(origin).host !== new URL(request.url).host) || !request.headers.get("content-type")?.startsWith("application/json")) throw new StaffingError("Invalid request", 403);
    const body = await request.json();
    if (!body || typeof body !== "object" || Object.keys(body).some(k => !["payroll_id", "recipient_version"].includes(k)) || typeof body.recipient_version !== "string" || !/^[a-f0-9]{32}$/.test(body.recipient_version)) throw new StaffingError("Penerima pengiriman tidak valid.", 400);
    const result = await sendPayrollDocument(getSupabaseAdmin(), await staffingActor(), staffId(body.payroll_id), body.recipient_version);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return staffingResponse(error); }
}
