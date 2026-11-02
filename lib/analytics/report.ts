import { unstable_cache } from "next/cache";
import { type Store } from "@/lib/stores";
import { demoAnalytics } from "./demo";
import { addDays, businessClock, withinBusinessTime, dateRange, reportingPeriod } from "./dashboard";
import { salesBenchmarks } from "./benchmarks";
import { loadHours, loadOrders, loadLines, type ReportOrder as Order, type ReportLine as Line } from "./sales-data";
import type { DashboardMode, DashboardReport, DashboardTotals } from "./types";

// Historical curves do not need the live feed's three-second refresh rate.
const historicalHours = unstable_cache(async (storeId: string, end: string) => {
  const rows = await loadHours(storeId, null, end);
  const hours = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const key = `${row.date}-${row.hour}`, existing = hours.get(key);
    if (existing) { existing.revenue += row.revenue; existing.quantity += row.quantity; }
    else hours.set(key, { ...row, itemCode: "", itemName: "", category: "" });
  }
  return [...hours.values()];
}, ["business-day-sales-v1"], { revalidate: 300 });

function totals(orders: Order[], lines: Line[]): DashboardTotals | null {
  if (!orders.length) return null;
  return lines.reduce<DashboardTotals>((total, line) => ({
    transactions: total.transactions,
    revenue: total.revenue + Number(line.gross_sales),
    units: total.units + Math.max(0, Number(line.quantity) - Number(line.returned_quantity)),
  }), { transactions: orders.length, revenue: 0, units: 0 });
}

export async function getDashboardReport(store: Store, mode: DashboardMode, date: string): Promise<DashboardReport> {
  const clock = businessClock(store.timeZone);
  const period = reportingPeriod(mode, date, clock.date);
  const partial = period.end === clock.date;
  const comparisonThrough = partial ? clock.time : null;
  const [hourlyItems, orders, allPreviousOrders, history] = await Promise.all([
    mode === "live" ? Promise.resolve([]) : loadHours(store.id, period.start, period.end),
    mode === "live" ? Promise.resolve([]) : loadOrders(store, period.start, period.end),
    loadOrders(store, period.comparisonStart, period.comparisonEnd),
    historicalHours(store.id, addDays(clock.date, -1)),
  ]);
  const previousOrders = allPreviousOrders.filter((order) => {
    if (!partial) return true;
    if (mode === "monthly" && order.business_date < period.comparisonEnd) return true;
    return withinBusinessTime(order.occurred_at, order.business_date, store.utcOffset, clock.time);
  });
  const [lines, previousLines] = await Promise.all([
    mode === "live" ? Promise.resolve([]) : loadLines(store, orders),
    loadLines(store, previousOrders),
  ]);
  const previousTotals = totals(previousOrders, previousLines);
  const comparison = previousTotals && mode !== "monthly" ? {
    revenue: previousTotals.revenue / 7, units: previousTotals.units / 7, transactions: previousTotals.transactions / 7,
  } : previousTotals;
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
    hourlyItems, daily, baskets, weekdayHours, comparison,
    comparisonStart: period.comparisonStart, comparisonEnd: period.comparisonEnd, comparisonThrough,
    benchmarks: salesBenchmarks(history, mode, period.start, period.end, period.comparisonStart, period.comparisonEnd),
  };
}

export function demoDashboardReport(mode: DashboardMode, date: string): DashboardReport {
  const sample = demoAnalytics(date);
  const period = reportingPeriod(mode, date, businessClock(sample.store.timeZone).date);
  // Only the supplied sample is available; don't manufacture a month of sales or deltas.
  return {
    date, mode, storeId: sample.store.id, source: "demo", startDate: period.start, endDate: period.end,
    hourlyItems: sample.hourlyItems.map((row) => ({ ...row, date })),
    daily: dateRange(period.start, period.end).map((day) => ({ date: day, revenue: day === date ? sample.totalRevenue : 0, units: day === date ? sample.totalUnits : 0, transactions: day === date ? sample.transactionCount : 0 })),
    baskets: ["1 item", "2 items", "3 items", "4 items", "5+ items"].map((label, index) => ({ label, count: index === 4 ? 1 : 0 })),
    weekdayHours: [], comparison: null, comparisonStart: period.comparisonStart, comparisonEnd: period.comparisonEnd, comparisonThrough: null,
    benchmarks: { average: [], averageLabel: "Previous 7 days avg.", best: [], bestDate: null },
  };
}
