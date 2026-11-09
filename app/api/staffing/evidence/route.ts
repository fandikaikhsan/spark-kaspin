import { staffingActor, staffingResponse, StaffingError } from "@/lib/staffing/service";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const attempt = parameters.get("attempt");
    const session = parameters.get("session");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if ((!attempt && !session) || (attempt && !uuid.test(attempt)) || (session && !uuid.test(session))) throw new StaffingError("Invalid evidence request", 400);
    const { data, error } = await getSupabaseAdmin().rpc("staffing_evidence", { ...await staffingActor(), p_session: session, p_attempt: attempt });
    if (error) throw new StaffingError("Bukti sementara tidak tersedia.", 503);
    if (!data?.length) throw new StaffingError("Bukti tidak ditemukan.", 404);
    if (!attempt) return Response.json(data.map((entry: Record<string, unknown>) => { const safe = { ...entry }; delete safe.file_id; return safe; }), { headers: { "Cache-Control": "no-store" } });
    const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN;
    if (!token) throw new StaffingError("Foto belum tersedia di dashboard. Bukti masih dapat dilihat di grup Telegram.", 503);
    const fileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: data[0].file_id }), cache: "no-store", signal: AbortSignal.timeout(8000) });
    const result = await fileResponse.json();
    if (!fileResponse.ok || !result.ok || !result.result?.file_path) throw new StaffingError("Foto sementara tidak tersedia.", 503);
    const photo = await fetch(`https://api.telegram.org/file/bot${token}/${result.result.file_path}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!photo.ok) throw new StaffingError("Foto sementara tidak tersedia.", 503);
    return new Response(photo.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return staffingResponse(error); }
}
