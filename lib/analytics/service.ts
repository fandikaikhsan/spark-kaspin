import { refreshIntervalSeconds } from "@/lib/env";
import { summarizeStore, type Store } from "@/lib/stores";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getRecentTransactions } from "@/lib/transactions";
import { summarizeHourlyItems } from "./aggregate";
import { businessWindow } from "./dashboard";
import { loadHours } from "./sales-data";
import type { DailyAnalytics } from "./types";

export async function getDailyAnalytics(
  store: Store,
  date: string,
  stores: Store[] = [store],
): Promise<DailyAnalytics> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  const supabase = getSupabaseAdmin();

  const window = businessWindow(date, date, store.utcOffset);
  const [hourlyItems, transactionsResult, syncResult, recentTransactions] = await Promise.all([
    loadHours(store.id, date, date),
    supabase
      .from("pos_transactions")
      .select("transaction_code", { count: "exact", head: true })
      .eq("store_id", store.id)
      .gte("occurred_at", window.from).lt("occurred_at", window.until),
    supabase
      .from("sync_runs")
      .select("completed_at")
      .eq("store_id", store.id)
      .gte("business_date", date).lte("business_date", window.until.slice(0, 10))
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getRecentTransactions(store, date),
  ]);

  if (transactionsResult.error) throw new Error(`Could not count transactions: ${transactionsResult.error.message}`);
  if (syncResult.error) throw new Error(`Could not load sync status: ${syncResult.error.message}`);

  const totals = summarizeHourlyItems(hourlyItems);

  return {
    date,
    source: "supabase",
    store: summarizeStore(store),
    stores: stores.map(summarizeStore),
    transactionCount: transactionsResult.count || 0,
    totalUnits: totals.totalUnits,
    totalRevenue: totals.totalRevenue,
    refreshSeconds: refreshIntervalSeconds(),
    lastSyncedAt: syncResult.data?.completed_at || null,
    hourlyItems,
    recentTransactions,
  };
}
