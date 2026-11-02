import { BUSINESS_HOURS, dateRange, hourlyRevenue } from "./dashboard";
import type { DashboardMode, DashboardReport, DatedHourlyItemSale } from "./types";

export function salesBenchmarks(rows: DatedHourlyItemSale[], mode: DashboardMode, start: string, end: string, previousStart: string, previousEnd: string): DashboardReport["benchmarks"] {
  const previous = rows.filter((row) => row.date >= previousStart && row.date <= previousEnd);
  // Aggregate products first. A peak is a whole hour/day's sales, not one product's maximum.
  const buckets = new Map<string, { date: string; slot: number; revenue: number }>();
  for (const row of rows) {
    const slot = mode === "monthly" ? Number(row.date.slice(8)) - 1 : BUSINESS_HOURS.indexOf(row.hour);
    const key = `${row.date}/${slot}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.revenue += row.revenue;
    else buckets.set(key, { date: row.date, slot, revenue: row.revenue });
  }
  const size = mode === "monthly" ? dateRange(start, end).length : 24;
  const peak: (number | null)[] = Array(size).fill(null);
  const peakDates: (string | null)[] = Array(size).fill(null);
  for (const bucket of buckets.values()) {
    if (bucket.slot < 0 || bucket.slot >= size) continue;
    const current = peak[bucket.slot], currentDate = peakDates[bucket.slot];
    if (current === null || bucket.revenue > current || bucket.revenue === current && (!currentDate || bucket.date < currentDate)) {
      peak[bucket.slot] = bucket.revenue; peakDates[bucket.slot] = bucket.date;
    }
  }
  if (mode !== "monthly") {
    const revenue = hourlyRevenue(previous);
    const average = previous.length ? BUSINESS_HOURS.map((hour) => revenue[hour] / 7) : [];
    return { average, averageLabel: "Previous 7 days avg.", peak, peakDates };
  }
  const dates = dateRange(start, end);
  const values = (month: string) => dates.map((date) => {
    const match = `${month}-${date.slice(8)}`;
    // February has no 30th/31st: leave a gap instead of fabricating zero sales.
    if (new Date(`${match}T12:00:00Z`).toISOString().slice(0, 10) !== match) return null;
    return rows.filter((row) => row.date === match).reduce((sum, row) => sum + row.revenue, 0);
  });
  return { average: previous.length ? values(previousStart.slice(0, 7)) : [], averageLabel: "Previous month", peak, peakDates };
}
