import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { currentSession } from "@/lib/auth/current-user";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { invitationHash } from "@/lib/staffing/telegram";
import { storeInstant, type StaffingData } from "@/lib/staffing/model";

export class StaffingError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function staffingActor() {
  const jar = await cookies();
  const session = await currentSession(await verifySessionToken(jar.get(SESSION_COOKIE)?.value));
  if (!session) throw new StaffingError("Authentication required", 401);
  return { p_actor: session.userId === "environment-super-admin" ? null : session.userId, p_bootstrap: session.userId === "environment-super-admin" && session.role === "super_admin" };
}

function databaseError(error: { message: string; code?: string }): never {
  if (error.message.includes("FORBIDDEN")) throw new StaffingError("Access denied", 403);
  if (["PGRST202", "42P01", "42883"].includes(error.code || "")) throw new StaffingError("Modul staffing belum tersedia. Hubungi administrator.", 503);
  if (error.code === "23505") throw new StaffingError("Data sudah terdaftar atau bertabrakan dengan catatan yang ada.", 409);
  if (["23503", "23514", "23502", "22P02", "22007", "22008"].includes(error.code || "")) throw new StaffingError("Periksa identitas, store, tanggal, dan kelengkapan data.", 400);
  if (error.code === "P0001") throw new StaffingError(error.message, 400);
  throw new StaffingError("Staffing sementara tidak dapat diakses.", 503);
}

export async function staffingDashboard(): Promise<StaffingData> {
  const { data, error } = await getSupabaseAdmin().rpc("staffing_dashboard", await staffingActor());
  if (error) databaseError(error);
  return data as StaffingData;
}

const actions = new Set(["region", "store_region", "manager_region", "group", "staff", "invite", "shift", "correction", "resolve_report"]);

export async function manageStaffing(action: string, input: unknown) {
  if (!actions.has(action) || !input || typeof input !== "object" || Array.isArray(input)) throw new StaffingError("Invalid staffing request", 400);
  const actor = await staffingActor();
  const value = { ...input } as Record<string, unknown>;
  let invitation: string | undefined;
  if (action === "invite") {
    const username = process.env.STAFFING_TELEGRAM_BOT_USERNAME?.trim();
    if (!username || !/^[a-z0-9_]+bot$/i.test(username)) throw new StaffingError("Bot staffing belum dikonfigurasi.", 503);
    const token = randomBytes(24).toString("hex");
    value.token_hash = invitationHash(token);
    invitation = `https://t.me/${username}?start=${token}`;
  }
  if (action === "group") {
    const validChat = (id: unknown): id is string => typeof id === "string" && /^-[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
    if (!validChat(value.chat_id) || (value.previous_chat_id !== undefined && !validChat(value.previous_chat_id))) {
      throw new StaffingError("Group ID harus berupa angka negatif Telegram.", 400);
    }
    const { data, error } = await getSupabaseAdmin().rpc("staffing_save_group", {
      ...actor, p_store: value.store_id, p_chat: value.chat_id,
      p_previous_chat: value.previous_chat_id ?? null,
      p_note: typeof value.note === "string" ? value.note : "",
    });
    if (error) databaseError(error);
    return data;
  }
  if (action === "shift" || action === "correction") {
    let storeId = value.store_id;
    if (action === "correction") {
      // Scope is checked again inside the transaction before anything changes.
      const {data:context,error}=await getSupabaseAdmin().rpc("staffing_session_context",{...actor,p_session:value.session_id});
      if(error)databaseError(error);
      storeId=context.store_id;
    }
    const { data: store, error } = await getSupabaseAdmin().from("stores").select("time_zone").eq("id", storeId).maybeSingle();
    if (error || !store) throw new StaffingError("Store tidak ditemukan.", 400);
    try {
      if (action === "shift") {
        value.starts_at = storeInstant(value.starts_local, store.time_zone);
        value.ends_at = storeInstant(value.ends_local, store.time_zone);
      } else {
        value.check_in_at = storeInstant(value.check_in_local, store.time_zone);
        value.check_out_at = value.check_out_local ? storeInstant(value.check_out_local, store.time_zone) : null;
      }
    } catch { throw new StaffingError("Periksa tanggal dan waktu sesuai timezone store.", 400); }
  }
  const { data, error } = await getSupabaseAdmin().rpc("staffing_manage", { ...actor, p_action: action, p_data: value });
  if (error) databaseError(error);
  return { ...data, ...(invitation ? { invitation } : {}) };
}

export function staffingResponse(error: unknown) {
  return Response.json({ error: error instanceof StaffingError ? error.message : "Staffing sementara tidak dapat diakses." }, { status: error instanceof StaffingError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}
