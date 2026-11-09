import { createClient } from "@supabase/supabase-js";

type Outbox = { id: number; method: string; payload: Record<string, unknown>; failures: number };
type FlushOptions = { budgetMs?: number; maxMessages?: number };

/** Shares a strict deadline across database, Telegram, and receipt requests. */
export function boundedFetch(deadline: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
}

export function staffingBotConflictsWithPos(): boolean {
  const staff = process.env.STAFFING_TELEGRAM_BOT_TOKEN?.trim();
  const pos = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return !!(staff && pos && staff.split(":")[0] === pos.split(":")[0]);
}

export async function flushStaffingNotifications({ budgetMs = 20000, maxMessages = 8 }: FlushOptions = {}) {
  const token = process.env.STAFFING_TELEGRAM_BOT_TOKEN?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!token || !url || !secret || budgetMs < 500) return { sent: 0, skipped: true, deferred: false };
  if (staffingBotConflictsWithPos()) throw new Error("Staffing and POS require distinct bot identities");
  const budget = Math.min(40000, Math.max(500, Math.floor(budgetMs)));
  const deadline = AbortSignal.timeout(budget);
  const end = Date.now() + budget;
  const limitedFetch = boundedFetch(deadline);
  const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: limitedFetch } });
  let sent = 0;
  try {
    for (let count = 0; count < Math.min(8, Math.max(0, Math.floor(maxMessages))); count++) {
      // Do not take another lease when there is almost no time left to deliver it.
      if (end - Date.now() < 500) return { sent, skipped: false, deferred: true };
      const { data, error } = await db.rpc("staffing_claim_outbox");
      if (error) throw new Error("Notification queue unavailable");
      const row = (data as Outbox[] | null)?.[0];
      if (!row) return { sent, skipped: false, deferred: false };
      try {
        const response = await limitedFetch(`https://api.telegram.org/bot${token}/${row.method}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row.payload),
          signal: AbortSignal.timeout(8000),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error("Telegram delivery failed");
        const delivered = await db.rpc("staffing_deliver_outbox", { p_id: row.id, p_message_id: result.result.message_id });
        if (delivered.error) throw new Error("Notification receipt unavailable");
        sent++;
      } catch {
        if (deadline.aborted) return { sent, skipped: false, deferred: true };
        const retry = await db.from("staffing_outbox").update({
          failures: row.failures + 1,
          retry_at: new Date(Date.now() + Math.min(300, 15 * 2 ** Math.min(row.failures, 5)) * 1000).toISOString(),
        }).eq("id", row.id).is("delivered_at", null);
        if (retry.error) throw new Error("Notification retry unavailable");
        return { sent, skipped: false, deferred: true };
      }
    }
    return { sent, skipped: false, deferred: true };
  } catch {
    // An expired deadline leaves any claimed row on its existing 90-second lease.
    if (deadline.aborted) return { sent, skipped: false, deferred: true };
    throw new Error("Staffing notification processing failed");
  }
}
