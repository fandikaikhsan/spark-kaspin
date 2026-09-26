import { posEnv, refreshIntervalSeconds } from "@/lib/env";
import { fetchTransactionsForDate } from "@/lib/pos/client";
import { normalizeTransactions } from "@/lib/pos/normalize";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type SyncResult = {
  status: "success" | "skipped";
  date: string;
  transactionCount: number;
  itemCount: number;
  reason?: string;
};

function chunks<T>(rows: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

async function recentlySynced(): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("sync_runs")
    .select("completed_at")
    .eq("status", "success")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not check the last sync: ${error.message}`);
  if (!data?.completed_at) return false;
  return Date.now() - new Date(data.completed_at).getTime() < refreshIntervalSeconds() * 1000;
}

export function currentBusinessDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.POS_TIME_ZONE || "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function syncPosDate(
  date = currentBusinessDate(),
  options: { force?: boolean; trigger?: string } = {},
): Promise<SyncResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  if (!options.force && (await recentlySynced())) {
    return { status: "skipped", date, transactionCount: 0, itemCount: 0, reason: "refresh interval has not elapsed" };
  }

  const supabase = getSupabaseAdmin();
  const { data: run, error: runError } = await supabase
    .from("sync_runs")
    .insert({ business_date: date, trigger: options.trigger || "manual", status: "running" })
    .select("id")
    .single();

  if (runError) throw new Error(`Could not create sync run: ${runError.message}`);

  try {
    const source = await fetchTransactionsForDate(date);
    const rows = normalizeTransactions(source, posEnv().utcOffset);

    for (const batch of chunks(rows.transactions)) {
      const { error } = await supabase
        .from("pos_transactions")
        .upsert(batch, { onConflict: "transaction_code" });
      if (error) throw new Error(`Could not save transactions: ${error.message}`);
    }

    for (const batch of chunks(rows.items)) {
      const { error } = await supabase
        .from("pos_transaction_items")
        .upsert(batch, { onConflict: "transaction_code,line_number" });
      if (error) throw new Error(`Could not save transaction items: ${error.message}`);
    }

    const completedAt = new Date().toISOString();
    const { error: completeError } = await supabase
      .from("sync_runs")
      .update({
        status: "success",
        completed_at: completedAt,
        transaction_count: rows.transactions.length,
        item_count: rows.items.length,
      })
      .eq("id", run.id);
    if (completeError) throw new Error(`Could not finish sync run: ${completeError.message}`);

    return {
      status: "success",
      date,
      transactionCount: rows.transactions.length,
      itemCount: rows.items.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    await supabase
      .from("sync_runs")
      .update({ status: "failed", completed_at: new Date().toISOString(), error_message: message })
      .eq("id", run.id);
    throw error;
  }
}
