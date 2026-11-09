import { createClient } from "@supabase/supabase-js";
import { boundedFetch, flushStaffingNotifications, staffingBotConflictsWithPos } from "./notifications";
import { normalizeUpdate, verifyWebhookSecret, type TelegramUpdate } from "./telegram";

type Event = { body?: string | null; isBase64Encoded?: boolean; headers?: Record<string, string | undefined>; flush?: boolean; requestContext?: unknown };
export type StaffingRuntimeContext = { getRemainingTimeInMillis(): number };

export async function handleStaffingWebhook(event: Event, context?: StaffingRuntimeContext) {
  const scheduled = event.flush === true && !event.requestContext;
  const header = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === "x-telegram-bot-api-secret-token")?.[1];
  if (!scheduled && !verifyWebhookSecret(header, process.env.STAFFING_TELEGRAM_WEBHOOK_SECRET)) return { statusCode: 401, body: "Unauthorized" };
  const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN;
  const username = process.env.STAFFING_TELEGRAM_BOT_USERNAME;
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !username || !url || !secret || staffingBotConflictsWithPos()) return { statusCode: 503, body: "Staffing configuration unavailable" };
  const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch(AbortSignal.timeout(8000)) } });
  async function telegram(method: string, payload: Record<string, unknown>) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error("Telegram delivery failed");
    return result.result;
  }
  try {
    if (!scheduled) {
      let update: TelegramUpdate;
      try { update = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}"); }
      catch { return { statusCode: 400, body: "Invalid update" }; }
      if (!update || typeof update !== "object" || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return { statusCode: 400, body: "Invalid update" };
      const normalized = normalizeUpdate(update, username);
      if (normalized) {
        const result = await db.rpc("staffing_apply_update", { p_update: normalized });
        if (result.error) throw new Error("Attendance transaction failed");
      }
      if (typeof update.callback_query?.id === "string" && update.callback_query.id.length <= 512) {
        // Generic acknowledgement does not imply that ownership/scope validation succeeded.
        try { await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Permintaan diproses. Periksa balasan bot atau hubungi manager." }); } catch { /* The committed transaction remains valid if the callback expires. */ }
      }
    }
    // Webhooks deliver immediately; the existing POS schedule retries any remainder.
    const budgetMs = Math.min(20000, context ? Math.max(0, context.getRemainingTimeInMillis() - 5000) : 20000);
    await flushStaffingNotifications({ budgetMs });
    return { statusCode: 200, body: "OK" };
  } catch {
    // Do not log update bodies, invitation tokens, medical/private messages, or bot URLs.
    console.error("Staffing webhook processing failed");
    return { statusCode: 503, body: "Staffing temporarily unavailable" };
  }
}
