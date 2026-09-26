import type { DailyAnalytics, HourlyItemSale } from "./types";

export function summarizeHourlyItems(
  rows: HourlyItemSale[],
): Pick<DailyAnalytics, "totalUnits" | "totalRevenue"> {
  return rows.reduce(
    (summary, row) => ({
      totalUnits: summary.totalUnits + row.quantity,
      totalRevenue: summary.totalRevenue + row.revenue,
    }),
    { totalUnits: 0, totalRevenue: 0 },
  );
}

export function hottestItem(rows: HourlyItemSale[]): HourlyItemSale | null {
  const totals = new Map<string, HourlyItemSale>();

  for (const row of rows) {
    const current = totals.get(row.itemCode);
    if (current) {
      current.quantity += row.quantity;
      current.revenue += row.revenue;
    } else {
      totals.set(row.itemCode, { ...row });
    }
  }

  return [...totals.values()].sort(
    (a, b) => b.quantity - a.quantity || b.revenue - a.revenue,
  )[0] ?? null;
}
