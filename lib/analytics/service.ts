import { refreshIntervalSeconds } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { summarizeHourlyItems } from "./aggregate";
import type { DailyAnalytics, HourlyItemSale } from "./types";

type HourlyViewRow = {
  item_code: string;
  item_name: string;
  category: string;
  business_hour: number;
  quantity: number;
  revenue: number;
};

async function loadAllHourlyRows(date: string): Promise<HourlyViewRow[]> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1_000;
  const rows: HourlyViewRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("pos_hourly_item_sales")
      .select("item_code,item_name,category,business_hour,quantity,revenue")
      .eq("business_date", date)
      .order("item_code", { ascending: true })
      .order("business_hour", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Could not load hourly sales: ${error.message}`);
    const page = (data || []) as HourlyViewRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function getDailyAnalytics(date: string): Promise<DailyAnalytics> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  const supabase = getSupabaseAdmin();

  const [hourlyRows, transactionsResult, syncResult] = await Promise.all([
    loadAllHourlyRows(date),
    supabase
      .from("pos_transactions")
      .select("transaction_code", { count: "exact", head: true })
      .eq("business_date", date),
    supabase
      .from("sync_runs")
      .select("completed_at")
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (transactionsResult.error) throw new Error(`Could not count transactions: ${transactionsResult.error.message}`);
  if (syncResult.error) throw new Error(`Could not load sync status: ${syncResult.error.message}`);

  const hourlyItems: HourlyItemSale[] = hourlyRows.map(
    (row) => ({
      itemCode: row.item_code,
      itemName: row.item_name,
      category: row.category,
      hour: Number(row.business_hour),
      quantity: Number(row.quantity),
      revenue: Number(row.revenue),
    }),
  );
  const totals = summarizeHourlyItems(hourlyItems);

  return {
    date,
    source: "supabase",
    transactionCount: transactionsResult.count || 0,
    totalUnits: totals.totalUnits,
    totalRevenue: totals.totalRevenue,
    refreshSeconds: refreshIntervalSeconds(),
    lastSyncedAt: syncResult.data?.completed_at || null,
    hourlyItems,
  };
}
