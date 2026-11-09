import { staffingActor, staffingResponse, StaffingError } from "@/lib/staffing/service";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const attempt = parameters.get("attempt"), session = parameters.get("session"), personalRequest = parameters.get("request");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if ((!attempt && !session && !personalRequest) || [attempt, session, personalRequest].some(id => id !== null && !uuid.test(id)) || (personalRequest && (attempt || session))) throw new StaffingError("Invalid evidence request", 400);
    const actor = await staffingActor();
    const { data, error } = personalRequest
      ? await getSupabaseAdmin().rpc("staffing_request_evidence", { ...actor, p_request: personalRequest })
      : await getSupabaseAdmin().rpc("staffing_evidence", { ...actor, p_session: session, p_attempt: attempt });
    if (error) throw new StaffingError(error.message?.includes("FORBIDDEN") ? "Access denied" : "Bukti sementara tidak tersedia.", error.message?.includes("FORBIDDEN") ? 403 : 503);
    if (personalRequest ? !data?.file_id : !data?.length) throw new StaffingError("Bukti tidak ditemukan.", 404);
    if (!attempt && !personalRequest) return Response.json(data.map((entry: Record<string, unknown>) => { const safe = { ...entry }; delete safe.file_id; return safe; }), { headers: { "Cache-Control": "no-store" } });
    const evidence = personalRequest ? data : data[0];
    const mime = personalRequest ? evidence.mime : "image/jpeg";
    if (!["image/jpeg", "image/png", "application/pdf"].includes(mime)) throw new StaffingError("Jenis bukti tidak didukung.", 400);
    const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN;
    if (!token) throw new StaffingError("Bukti belum tersedia di dashboard.", 503);
    const fileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: evidence.file_id }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
    const result = await fileResponse.json();
    const path = result.result?.file_path;
    if (!fileResponse.ok || !result.ok || typeof path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.includes("..") || result.result.file_size > 10 * 1024 * 1024) throw new StaffingError("Bukti sementara tidak tersedia.", 503);
    const file = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!file.ok || Number(file.headers.get("content-length")) > 10 * 1024 * 1024) throw new StaffingError("Bukti sementara tidak tersedia.", 503);
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > 10 * 1024 * 1024) throw new StaffingError("Bukti terlalu besar.", 413);
    return new Response(bytes, { headers: { "Content-Type": mime, "Content-Disposition": `${mime === "application/pdf" ? "attachment" : "inline"}; filename="bukti.${mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } });
  } catch (error) { return staffingResponse(error); }
}
