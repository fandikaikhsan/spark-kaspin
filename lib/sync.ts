import { refreshIntervalSeconds } from "@/lib/env";
import { fetchTransactionsForDate } from "@/lib/pos/client";
import { normalizeTransactions } from "@/lib/pos/normalize";
import { businessDateForTimeZone, type Store } from "@/lib/stores";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type SyncResult = {
  status: "success" | "skipped";
  storeId: string;
  storeName: string;
  date: string;
  transactionCount: number;
  itemCount: number;
  reason?: string;
};

export type SyncRunSummary = {
  status: "success" | "failed";
  successfulCycles: number;
  failedCycles: number;
  transactionCount: number;
  itemCount: number;
  errorMessage?: string;
};

function chunks<T>(rows: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

async function recentlySynced(storeId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("sync_runs")
    .select("completed_at")
    .eq("store_id", storeId)
    .eq("status", "success")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not check the last sync: ${error.message}`);
  if (!data?.completed_at) return false;
  return Date.now() - new Date(data.completed_at).getTime() < refreshIntervalSeconds() * 1000;
}

export function currentBusinessDate(timeZone = process.env.POS_TIME_ZONE || "Asia/Jakarta"): string {
  return businessDateForTimeZone(timeZone);
}

export async function createSyncRun(store: Store, date: string, trigger: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("sync_runs")
    .insert({
      store_id: store.id,
      business_date: date,
      trigger,
      status: "running",
    })
    .select("id")
    .single();

  if (error) throw new Error(`Could not create sync run: ${error.message}`);
  return Number(data.id);
}

export async function completeSyncRun(runId: number, summary: SyncRunSummary): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("sync_runs")
    .update({
      status: summary.status,
      completed_at: new Date().toISOString(),
      successful_cycles: summary.successfulCycles,
      failed_cycles: summary.failedCycles,
      transaction_count: summary.transactionCount,
      item_count: summary.itemCount,
      error_message: summary.errorMessage || null,
    })
    .eq("id", runId);

  if (error) throw new Error(`Could not finish sync run: ${error.message}`);
}

export async function syncStoreData(store: Store, date: string): Promise<SyncResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  const source = await fetchTransactionsForDate(store, date);
  const rows = normalizeTransactions(source, store.id, store.utcOffset);
  const supabase = getSupabaseAdmin();

  for (const batch of chunks(rows.transactions)) {
    const { error } = await supabase
      .from("pos_transactions")
      .upsert(batch, { onConflict: "store_id,transaction_code" });
    if (error) throw new Error(`Could not save transactions: ${error.message}`);
  }

  for (const batch of chunks(rows.items)) {
    const { error } = await supabase
      .from("pos_transaction_items")
      .upsert(batch, { onConflict: "store_id,transaction_code,line_number" });
    if (error) throw new Error(`Could not save transaction items: ${error.message}`);
  }

  return {
    status: "success",
    storeId: store.id,
    storeName: store.name,
    date,
    transactionCount: rows.transactions.length,
    itemCount: rows.items.length,
  };
}

export async function syncPosDate(
  store: Store,
  date = currentBusinessDate(store.timeZone),
  options: { force?: boolean; trigger?: string } = {},
): Promise<SyncResult> {
  if (!options.force && (await recentlySynced(store.id))) {
    return {
      status: "skipped",
      storeId: store.id,
      storeName: store.name,
      date,
      transactionCount: 0,
      itemCount: 0,
      reason: "refresh interval has not elapsed",
    };
  }

  const runId = await createSyncRun(store, date, options.trigger || "manual");
  try {
    const result = await syncStoreData(store, date);
    await completeSyncRun(runId, {
      status: "success",
      successfulCycles: 1,
      failedCycles: 0,
      transactionCount: result.transactionCount,
      itemCount: result.itemCount,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    await completeSyncRun(runId, {
      status: "failed",
      successfulCycles: 0,
      failedCycles: 1,
      transactionCount: 0,
      itemCount: 0,
      errorMessage: message,
    });
    throw error;
  }
}

export async function cleanupSyncRuns(now = new Date()): Promise<void> {
  const supabase = getSupabaseAdmin();
  const successfulCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const failedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const interruptedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const { error: interruptedError } = await supabase
    .from("sync_runs")
    .update({
      status: "failed",
      completed_at: now.toISOString(),
      error_message: "Invocation ended before the sync run completed",
    })
    .eq("status", "running")
    .lt("started_at", interruptedCutoff);
  if (interruptedError) throw new Error(`Could not close interrupted sync runs: ${interruptedError.message}`);

  const { error: successError } = await supabase
    .from("sync_runs")
    .delete()
    .eq("status", "success")
    .lt("started_at", successfulCutoff);
  if (successError) throw new Error(`Could not clean successful sync runs: ${successError.message}`);

  const { error: failedError } = await supabase
    .from("sync_runs")
    .delete()
    .eq("status", "failed")
    .lt("started_at", failedCutoff);
  if (failedError) throw new Error(`Could not clean failed sync runs: ${failedError.message}`);
}
