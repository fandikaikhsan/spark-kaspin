import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { staffingActor, staffingResponse, StaffingError } from "@/lib/staffing/service";
import { validMonday } from "@/lib/staffing/schedule";
export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(store: unknown, week: unknown) {
  if (typeof store !== "string" || !uuid.test(store) || typeof week !== "string" || !validMonday(week)) throw new StaffingError("Pilih store dan minggu yang valid.", 400);
}
function failure(error: { message: string; code?: string }): never {
  const messages: Record<string, string> = {
    SCHEDULE_STALE: "Jadwal berubah sejak dibuka. Muat ulang sebelum commit; draft kamu tetap ada.",
    SCHEDULE_LOCKED: "Shift yang sudah memiliki proses atau catatan absensi tidak dapat diubah atau dihapus.",
    SCHEDULE_OVERLAP: "Ada penugasan staff yang bertabrakan, termasuk di store lain. Tidak ada perubahan disimpan.",
  };
  if (error.message === "FORBIDDEN") throw new StaffingError("Access denied", 403);
  if (messages[error.message]) throw new StaffingError(messages[error.message], 409);
  if (["PGRST202", "42883"].includes(error.code || "")) throw new StaffingError("Perencana jadwal belum tersedia. Hubungi administrator.", 503);
  throw new StaffingError("Jadwal tidak dapat disimpan. Periksa waktu, staff, dan akses store.", 400);
}
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const store = params.get("store"); const week = params.get("week"); validate(store, week);
    const { data, error } = await getSupabaseAdmin().rpc("staffing_schedule_week", { ...await staffingActor(), p_store: store, p_week: week });
    if (error) failure(error);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return staffingResponse(error); }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if ((origin && new URL(origin).host !== new URL(request.url).host) || !request.headers.get("content-type")?.startsWith("application/json")) throw new StaffingError("Invalid request origin or content type", 403);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new StaffingError("Draft jadwal tidak valid.", 400);
    validate(body.store_id, body.week_start);
    if (!Array.isArray(body.shifts) || body.shifts.length > 1000 || typeof body.version !== "string") throw new StaffingError("Draft jadwal tidak valid.", 400);
    const { data, error } = await getSupabaseAdmin().rpc("staffing_commit_week", { ...await staffingActor(), p_store: body.store_id, p_week: body.week_start, p_version: body.version, p_shifts: body.shifts });
    if (error) failure(error);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return staffingResponse(error); }
}
