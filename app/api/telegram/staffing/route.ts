import { handleStaffingWebhook } from "@/lib/staffing/webhook";
import { verifyWebhookSecret } from "@/lib/staffing/telegram";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") || undefined;
  if (!verifyWebhookSecret(secret, process.env.STAFFING_TELEGRAM_WEBHOOK_SECRET)) return new Response("Unauthorized", { status: 401, headers });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return new Response("Expected JSON", { status: 415, headers });
  if (Number(request.headers.get("content-length")) > 1024 * 1024) return new Response("Update too large", { status: 413, headers });
  let body: string;
  try { body = await request.text(); } catch { return new Response("Invalid update", { status: 400, headers }); }
  if (Buffer.byteLength(body, "utf8") > 1024 * 1024) return new Response("Update too large", { status: 413, headers });
  // Context is constructed here, never taken from message text or JSON flags.
  const result = await handleStaffingWebhook({ body, headers: { "x-telegram-bot-api-secret-token": secret }, requestContext: { http: { method: "POST", path: "/api/telegram/staffing" } } });
  return new Response(result.body, { status: result.statusCode, headers });
}
