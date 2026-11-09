import { createPayrollPdf, type PayrollDocumentData } from "./payroll-document";
import { staffingBotConflictsWithPos } from "./notifications";
import { StaffingError } from "./service";
type Reservation = { already_sent: boolean; token: string; telegram_user_id: number; document: PayrollDocumentData };
type Database = { rpc(name: string, data: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export async function sendPayrollDocument(db: Database, actor: { p_actor: string | null; p_bootstrap: boolean }, payroll: string, recipientVersion: string) {
  const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN?.trim();
  if (!token || staffingBotConflictsWithPos()) throw new StaffingError("Bot Staffing belum dikonfigurasi dengan benar.", 503);
  const reserved = await db.rpc("staffing_reserve_payroll_delivery", { ...actor, p_payroll: payroll, p_recipient_version: recipientVersion });
  if (reserved.error) { const message = (reserved.error as { message?: string }).message || "Pengiriman tidak tersedia."; throw new StaffingError(message.includes("FORBIDDEN") ? "Access denied" : message.includes("PAYROLL_RECIPIENT_CHANGED") ? "Akun penerima berubah. Muat ulang pratinjau sebelum mengirim." : message, message.includes("FORBIDDEN") ? 403 : 409); }
  const reservation = reserved.data as Reservation;
  if (reservation.already_sent) return { state: "sent", already_sent: true };
  let attempted = false;
  async function finish(state: string, message: number | null = null) {
    const result = await db.rpc("staffing_finish_payroll_delivery", { p_payroll: payroll, p_token: reservation.token, p_state: state, p_message: message });
    if (result.error) throw new Error("Delivery receipt unavailable");
  }
  try {
    if (!Number.isSafeInteger(reservation.telegram_user_id) || reservation.telegram_user_id <= 0) throw new Error("Invalid recipient");
    const check = await fetch(`https://api.telegram.org/bot${token}/getChat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: reservation.telegram_user_id }), redirect: "error", signal: AbortSignal.timeout(8000) });
    const chat = await check.json();
    if (!check.ok || !chat.ok || chat.result?.type !== "private" || chat.result.id !== reservation.telegram_user_id) throw new Error("Recipient private chat unavailable");
    const bytes = await createPayrollPdf(reservation.document);
    const form = new FormData();
    form.set("chat_id", String(reservation.telegram_user_id));
    form.set("protect_content", "true");
    form.set("caption", `Slip payroll FINAL · ${reservation.document.staff_name}\n${reservation.document.period_start} – ${reservation.document.period_end}`);
    form.set("document", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), `payroll-${reservation.document.staff_code}-${reservation.document.period_start}.pdf`);
    attempted = true;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      // Only explicit Telegram 4xx rejection proves the upload was not delivered.
      if (response.status >= 400 && response.status < 500 && result.ok === false) attempted = false;
      throw new Error("Telegram document delivery unavailable");
    }
    if (result.result?.chat?.id !== reservation.telegram_user_id || result.result?.chat?.type !== "private" || !Number.isSafeInteger(result.result?.message_id)) throw new Error("Delivery identity could not be verified");
    await finish("sent", result.result.message_id);
    return { state: "sent", already_sent: false };
  } catch {
    try { await finish(attempted ? "uncertain" : "failed"); } catch { /* Retain sending state; never silently resend an upload with no receipt. */ }
    throw new StaffingError(attempted ? "Status kirim belum dapat dipastikan. Periksa chat staf sebelum mengirim ulang; sistem tidak mengulang otomatis." : "PDF belum terkirim. Pastikan staf sudah Start bot dan chat pribadi dapat diakses, lalu coba lagi.", 503);
  }
}
