import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { type Store } from "@/lib/stores";
import { demoAnalytics } from "./demo";
import { dateRange, localClock, reportingPeriod } from "./dashboard";
import type { DashboardMode, DashboardReport, DashboardTotals, DatedHourlyItemSale } from "./types";

type Order = { transaction_code: string; business_date: string; business_hour: number };
type Line = { transaction_code: string; quantity: number; returned_quantity: number; gross_sales: number };
type HourlyRow = { business_date: string; business_hour: number; item_code: string; item_name: string; category: string; quantity: number; revenue: number };

async function allOrders(store: Store, start: string, end: string, through?: string): Promise<Order[]> {
  const rows: Order[] = [];
  for (let from = 0; ; from += 1000) {
    let query = getSupabaseAdmin().from("pos_transactions")
      .select("transaction_code,business_date,business_hour")
      .eq("store_id", store.id).gte("business_date", start).lte("business_date", end);
    if (through) query = query.lte("occurred_at", through);
    const { data, error } = await query.order("transaction_code").range(from, from + 999);
    if (error) throw new Error(`Could not load report transactions: ${error.message}`);
    rows.push(...(data || []) as Order[]);
    if (!data || data.length < 1000) return rows;
  }
}

async function allLines(store: Store, orders: Order[]): Promise<Line[]> {
  const rows: Line[] = [];
  // Bound the URL size and paginate each group so large receipts aren't truncated.
  for (let index = 0; index < orders.length; index += 150) {
    const codes = orders.slice(index, index + 150).map((order) => order.transaction_code);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await getSupabaseAdmin().from("pos_transaction_items")
        .select("transaction_code,quantity,returned_quantity,gross_sales")
        .eq("store_id", store.id).in("transaction_code", codes)
        .order("transaction_code").order("line_number").range(from, from + 999);
      if (error) throw new Error(`Could not load report items: ${error.message}`);
      rows.push(...(data || []) as Line[]);
      if (!data || data.length < 1000) break;
    }
  }
  return rows;
}

async function allHours(store: Store, start: string, end: string): Promise<DatedHourlyItemSale[]> {
  const rows: DatedHourlyItemSale[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await getSupabaseAdmin().from("pos_hourly_item_sales")
      .select("business_date,business_hour,item_code,item_name,category,quantity,revenue")
      .eq("store_id", store.id).gte("business_date", start).lte("business_date", end)
      .order("business_date").order("item_code").order("business_hour").range(from, from + 999);
    if (error) throw new Error(`Could not load report sales: ${error.message}`);
    rows.push(...((data || []) as HourlyRow[]).map((row) => ({
      date: row.business_date, hour: Number(row.business_hour), itemCode: row.item_code,
      itemName: row.item_name, category: row.category, quantity: Number(row.quantity), revenue: Number(row.revenue),
    })));
    if (!data || data.length < 1000) return rows;
  }
}

function totals(orders: Order[], lines: Line[]): DashboardTotals | null {
  if (!orders.length) return null;
  return lines.reduce<DashboardTotals>((total, line) => ({
    transactions: total.transactions,
    revenue: total.revenue + Number(line.gross_sales),
    units: total.units + Math.max(0, Number(line.quantity) - Number(line.returned_quantity)),
  }), { transactions: orders.length, revenue: 0, units: 0 });
}

export async function getDashboardReport(store: Store, mode: DashboardMode, date: string): Promise<DashboardReport> {
  const clock = localClock(store.timeZone);
  const period = reportingPeriod(mode, date, clock.date);
  const comparisonThrough = period.end === clock.date
    ? `${period.comparisonEnd}T${clock.time}${store.utcOffset}` : null;
  const [hourlyItems, orders, previousOrders] = await Promise.all([
    mode === "live" ? Promise.resolve([]) : allHours(store, period.start, period.end),
    mode === "live" ? Promise.resolve([]) : allOrders(store, period.start, period.end),
    allOrders(store, period.comparisonStart, period.comparisonEnd, comparisonThrough || undefined),
  ]);
  const [lines, previousLines] = await Promise.all([
    mode === "live" ? Promise.resolve([]) : allLines(store, orders),
    allLines(store, previousOrders),
  ]);
  const dates = dateRange(period.start, period.end);
  const daily = dates.map((date) => ({ date, revenue: 0, units: 0, transactions: 0 }));
  const byDate = new Map(daily.map((day) => [day.date, day]));
  for (const row of hourlyItems) {
    const day = byDate.get(row.date)!;
    day.revenue += row.revenue;
    day.units += row.quantity;
  }
  const weekdayHours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, occurrences: 0, hours: Array<number>(24).fill(0) }));
  for (const day of dates) weekdayHours[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7].occurrences++;
  for (const order of orders) {
    byDate.get(order.business_date)!.transactions++;
    const weekday = (new Date(`${order.business_date}T12:00:00Z`).getUTCDay() + 6) % 7;
    weekdayHours[weekday].hours[Number(order.business_hour)]++;
  }
  for (const row of weekdayHours) row.hours = row.hours.map((count) => row.occurrences ? count / row.occurrences : 0);
  const byOrder = new Map<string, number>(orders.map((order) => [order.transaction_code, 0]));
  for (const line of lines) byOrder.set(line.transaction_code, (byOrder.get(line.transaction_code) || 0) + Math.max(0, Number(line.quantity) - Number(line.returned_quantity)));
  const baskets = ["1 item", "2 items", "3 items", "4 items", "5+ items"].map((label) => ({ label, count: 0 }));
  // Fully returned orders (zero remaining units) aren't a positive basket.
  for (const quantity of byOrder.values()) if (quantity > 0) baskets[Math.min(4, Math.max(0, Math.ceil(quantity) - 1))].count++;
  return {
    date, mode, storeId: store.id, source: "supabase", startDate: period.start, endDate: period.end,
    hourlyItems, daily, baskets, weekdayHours, comparison: totals(previousOrders, previousLines),
    comparisonStart: period.comparisonStart, comparisonEnd: period.comparisonEnd, comparisonThrough,
  };
}

export function demoDashboardReport(mode: DashboardMode, date: string): DashboardReport {
  const sample = demoAnalytics(date);
  const period = reportingPeriod(mode, date, localClock(sample.store.timeZone).date);
  // Only the supplied sample is available; don't manufacture a month of sales or deltas.
  return {
    date, mode, storeId: sample.store.id, source: "demo", startDate: period.start, endDate: period.end,
    hourlyItems: sample.hourlyItems.map((row) => ({ ...row, date })),
    daily: dateRange(period.start, period.end).map((day) => ({ date: day, revenue: day === date ? sample.totalRevenue : 0, units: day === date ? sample.totalUnits : 0, transactions: day === date ? sample.transactionCount : 0 })),
    baskets: ["1 item", "2 items", "3 items", "4 items", "5+ items"].map((label, index) => ({ label, count: index === 4 ? 1 : 0 })),
    weekdayHours: [], comparison: null, comparisonStart: period.comparisonStart, comparisonEnd: period.comparisonEnd, comparisonThrough: null,
  };
}
