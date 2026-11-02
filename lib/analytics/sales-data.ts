import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Store } from "@/lib/stores";
import { addDays, businessWindow, reportingDate } from "./dashboard";
import type { DatedHourlyItemSale } from "./types";

export type ReportOrder = { transaction_code: string; business_date: string; business_hour: number; occurred_at: string };
export type ReportLine = { transaction_code: string; quantity: number; returned_quantity: number; gross_sales: number };

export async function loadOrders(store: Store, start: string, end: string): Promise<ReportOrder[]> {
  const window = businessWindow(start, end, store.utcOffset);
  const rows: ReportOrder[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await getSupabaseAdmin().from("pos_transactions")
      .select("transaction_code,business_date,business_hour,occurred_at").eq("store_id", store.id)
      .gte("occurred_at", window.from).lt("occurred_at", window.until)
      .order("transaction_code").range(from, from + 999);
    if (error) throw new Error(`Could not load report transactions: ${error.message}`);
    rows.push(...(data || []).map((row) => ({ ...row, business_date: reportingDate(row.business_date, row.business_hour) })));
    if (!data || data.length < 1000) return rows;
  }
}

export async function loadLines(store: Store, orders: ReportOrder[]): Promise<ReportLine[]> {
  const rows: ReportLine[] = [];
  for (let index = 0; index < orders.length; index += 150) {
    const codes = orders.slice(index, index + 150).map((order) => order.transaction_code);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await getSupabaseAdmin().from("pos_transaction_items")
        .select("transaction_code,quantity,returned_quantity,gross_sales").eq("store_id", store.id).in("transaction_code", codes)
        .order("transaction_code").order("line_number").range(from, from + 999);
      if (error) throw new Error(`Could not load report items: ${error.message}`);
      rows.push(...(data || []) as ReportLine[]);
      if (!data || data.length < 1000) break;
    }
  }
  return rows;
}

export async function loadHours(storeId: string, start: string | null, end: string): Promise<DatedHourlyItemSale[]> {
  const rows: DatedHourlyItemSale[] = [];
  for (let from = 0; ; from += 1000) {
    let query = getSupabaseAdmin().from("pos_hourly_item_sales")
      .select("business_date,business_hour,item_code,item_name,category,quantity,revenue")
      .eq("store_id", storeId).lte("business_date", addDays(end, 1));
    if (start) query = query.gte("business_date", start);
    const { data, error } = await query.order("business_date").order("item_code").order("business_hour").range(from, from + 999);
    if (error) throw new Error(`Could not load hourly sales: ${error.message}`);
    for (const row of data || []) {
      const date = reportingDate(row.business_date, Number(row.business_hour));
      if ((!start || date >= start) && date <= end) rows.push({ date, hour: Number(row.business_hour), itemCode: row.item_code,
        itemName: row.item_name, category: row.category, quantity: Number(row.quantity), revenue: Number(row.revenue) });
    }
    if (!data || data.length < 1000) return rows;
  }
}
