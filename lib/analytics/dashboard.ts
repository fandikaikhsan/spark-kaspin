import type { DashboardMode, DashboardTotals, HourlyItemSale } from "./types";

export type ProductSales = {
  code: string;
  name: string;
  category: string;
  units: number;
  revenue: number;
  hours: number[];
};

export function isBusinessDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function localClock(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

export function reportingPeriod(mode: DashboardMode, date: string, today: string) {
  if (!isBusinessDate(date)) throw new Error("Date must be a valid YYYY-MM-DD date");
  if (date > today) throw new Error("Choose today or an earlier date");
  if (mode !== "monthly") {
    const previous = addDays(date, -7);
    return { start: date, end: date, comparisonStart: previous, comparisonEnd: previous };
  }
  const start = `${date.slice(0, 7)}-01`;
  const next = new Date(`${start}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = addDays(next.toISOString().slice(0, 10), -1);
  const end = last < today ? last : today;
  const comparisonEndOfMonth = addDays(start, -1);
  const comparisonStart = `${comparisonEndOfMonth.slice(0, 7)}-01`;
  const comparisonEnd = end === today
    ? `${comparisonStart.slice(0, 8)}${String(Math.min(Number(end.slice(8)), Number(comparisonEndOfMonth.slice(8)))).padStart(2, "0")}`
    : comparisonEndOfMonth;
  return { start, end, comparisonStart, comparisonEnd };
}

export function productSales(rows: HourlyItemSale[]): ProductSales[] {
  const products = new Map<string, ProductSales>();
  for (const row of rows) {
    let product = products.get(row.itemCode);
    if (!product) {
      product = { code: row.itemCode, name: row.itemName, category: row.category, units: 0, revenue: 0, hours: Array(24).fill(0) };
      products.set(row.itemCode, product);
    }
    product.units += row.quantity;
    product.revenue += row.revenue;
    product.hours[row.hour] += row.quantity;
  }
  return [...products.values()].sort((a, b) => b.revenue - a.revenue || b.units - a.units || a.code.localeCompare(b.code));
}

export function hourlyRevenue(rows: HourlyItemSale[]): number[] {
  const hours: number[] = Array(24).fill(0);
  for (const row of rows) hours[row.hour] += row.revenue;
  return hours;
}

export function averageOrderValue(totals: DashboardTotals): number | null {
  return totals.transactions > 0 ? totals.revenue / totals.transactions : null;
}

export function percentageChange(current: number, previous: number | null | undefined): number | null {
  return previous == null || previous <= 0 ? null : (current / previous - 1) * 100;
}

export function trailingAverage(values: number[], window = 7): (number | null)[] {
  return values.map((_, index) => index + 1 < window ? null
    : values.slice(index + 1 - window, index + 1).reduce((sum, value) => sum + value, 0) / window);
}
