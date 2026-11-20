import { operationsRpc, staffId } from "@/lib/staffing/operations-service";
import { staffingResponse, StaffingError } from "@/lib/staffing/service";
export const dynamic = "force-dynamic";
const fields: Record<string, string[]> = {
  save_draft: ["staff_id", "warning_id", "revision", "data", "client_id"],
  issue: ["warning_id", "revision", "points_version", "acknowledged", "client_id"],
  adjust_points: ["staff_id", "new_balance", "points_version", "reason", "client_id"],
  reduce_points: ["staff_id", "points", "points_version", "reason", "client_id"],
  revoke: ["warning_id", "revision", "points_version", "reason", "client_id"],
  resolve_delivery: ["warning_id", "document_version", "resolution", "reason", "acknowledged", "client_id"],
};
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    if (p.has("staff") === p.has("warning")) throw new StaffingError("Pilih staf atau surat.", 400);
    return Response.json(p.has("warning") ? await operationsRpc("staffing_warning_detail", { p_warning: staffId(p.get("warning")) }) : await operationsRpc("staffing_warning_list", { p_staff: staffId(p.get("staff")) }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return staffingResponse(error); }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if ((origin && new URL(origin).host !== new URL(request.url).host) || !request.headers.get("content-type")?.startsWith("application/json")) throw new StaffingError("Invalid request", 403);
    const body = await request.json();
    if (!body || typeof body.action !== "string" || !Object.hasOwn(fields, body.action) || !body.data || typeof body.data !== "object" || Array.isArray(body.data) || Object.keys(body).some(key => !["action", "data"].includes(key)) || Object.keys(body.data).some(key => !fields[body.action].includes(key))) throw new StaffingError("Aksi peringatan tidak valid.", 400);
    const data = body.data;
    staffId(data.client_id);
    for (const key of ["staff_id", "warning_id"]) if (data[key] !== undefined && data[key] !== null) staffId(data[key]);
    if (data.revision !== undefined && (!Number.isSafeInteger(data.revision) || data.revision < 0)) throw new StaffingError("Versi surat tidak valid.", 400);
    if (data.points_version !== undefined && !/^[a-f0-9]{32}$/.test(data.points_version)) throw new StaffingError("Versi poin tidak valid.", 400);
    if (data.points !== undefined && (!Number.isSafeInteger(data.points) || data.points < 1 || data.points > 1000000)) throw new StaffingError("Jumlah pengurangan poin tidak valid.", 400);
    if (body.action === "adjust_points" && (!Number.isSafeInteger(data.new_balance) || data.new_balance < 0 || data.new_balance > 1000000)) throw new StaffingError("Isi total poin baru berupa bilangan bulat 0 sampai 1000000.", 400);
    return Response.json(await operationsRpc("staffing_warning_manage", { p_action: body.action, p_data: data }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return staffingResponse(error); }
}
