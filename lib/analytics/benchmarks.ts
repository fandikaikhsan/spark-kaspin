import { BUSINESS_HOURS, dateRange, hourlyRevenue } from "./dashboard";
import type { DashboardMode, DashboardReport, DatedHourlyItemSale } from "./types";

export function salesBenchmarks(rows: DatedHourlyItemSale[], mode: DashboardMode, start: string, end: string, previousStart: string, previousEnd: string): DashboardReport["benchmarks"] {
  const previous = rows.filter((row) => row.date >= previousStart && row.date <= previousEnd);
  if (mode !== "monthly") {
    const average = previous.length ? BUSINESS_HOURS.map((hour) => hourlyRevenue(previous)[hour] / 7) : [];
    const days = new Map<string, DatedHourlyItemSale[]>();
    for (const row of rows) if (row.date < start) days.set(row.date, [...(days.get(row.date) || []), row]);
    const best = [...days].sort((a, b) => b[1].reduce((sum, row) => sum + row.revenue, 0) - a[1].reduce((sum, row) => sum + row.revenue, 0) || a[0].localeCompare(b[0]))[0];
    return { average, averageLabel: "Previous 7 days avg.", best: best ? BUSINESS_HOURS.map((hour) => hourlyRevenue(best[1])[hour]) : [], bestDate: best?.[0] || null };
  }
  const dates = dateRange(start, end);
  const months = new Map<string, number>();
  for (const row of rows) if (row.date < start) months.set(row.date.slice(0, 7), (months.get(row.date.slice(0, 7)) || 0) + row.revenue);
  const bestMonth = [...months].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const values = (month: string) => dates.map((date) => {
    const match = `${month}-${date.slice(8)}`;
    // February has no 30th/31st: leave a gap instead of fabricating zero sales.
    if (new Date(`${match}T12:00:00Z`).toISOString().slice(0, 10) !== match) return null;
    return rows.filter((row) => row.date === match).reduce((sum, row) => sum + row.revenue, 0);
  });
  return { average: previous.length ? values(previousStart.slice(0, 7)) : [], averageLabel: "Previous month", best: bestMonth ? values(bestMonth) : [], bestDate: bestMonth ? `${bestMonth}-01` : null };
}
