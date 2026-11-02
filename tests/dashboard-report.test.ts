import { afterEach, describe, expect, it, vi } from "vitest";
import { averageOrderValue } from "@/lib/analytics/dashboard";
import type { Store } from "@/lib/stores";
import type { ReportOrder } from "@/lib/analytics/sales-data";

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/analytics/sales-data", () => ({ loadHours: vi.fn(), loadOrders: vi.fn(), loadLines: vi.fn() }));
import { loadHours, loadOrders, loadLines } from "@/lib/analytics/sales-data";
import { getDashboardReport } from "@/lib/analytics/report";

const store: Store = { id: "palu", name: "Palu", timeZone: "Asia/Makassar", utcOffset: "+08:00", active: true, isDefault: true };
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("live seven-day KPI comparisons", () => {
  it("uses each day's same elapsed business time and a weighted AOV, including the after-midnight tail", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T16:30:00Z")); // 00:30 on Nov 3, still Nov 2's business day.
    const order = (code: string, date: string, time: string): ReportOrder => ({ transaction_code: code, business_date: date, business_hour: Number(time.slice(11,13)), occurred_at: time });
    const orders = [order("A", "2026-10-26", "2026-10-26T10:00:00+08:00"), order("B", "2026-11-01", "2026-11-02T00:00:00+08:00"), order("C", "2026-11-01", "2026-11-02T00:30:00+08:00"), order("D", "2026-11-01", "2026-11-02T00:31:00+08:00")];
    vi.mocked(loadHours).mockResolvedValue([]); vi.mocked(loadOrders).mockResolvedValue(orders);
    vi.mocked(loadLines).mockImplementation(async (_store, selected) => selected.map((order) => {
      const multiple = order.transaction_code.charCodeAt(0) - 64;
      return { transaction_code: order.transaction_code, quantity: 7 * multiple, returned_quantity: 0, gross_sales: 700 * multiple };
    }));
    const report = await getDashboardReport(store, "live", "2026-11-02");
    expect(loadOrders).toHaveBeenCalledWith(store, "2026-10-26", "2026-11-01");
    expect(vi.mocked(loadLines).mock.calls[0][1].map((order) => order.transaction_code)).toEqual(["A", "B", "C"]);
    expect(report.comparison).toEqual({ revenue: 600, units: 6, transactions: 3 / 7 });
    expect(averageOrderValue(report.comparison!)).toBe(1400);
    expect(report.comparisonThrough).toBe("00:30:00");
  });
  it("includes completed hours from today in all-time peaks but excludes the current partial hour", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T04:30:00Z")); // 12:30 WITA.
    const row = (date: string, hour: number, revenue: number) => ({ date, hour, revenue, quantity: 1, itemCode: "A", itemName: "A", category: "Food" });
    vi.mocked(loadHours).mockResolvedValue([row("2026-11-01", 11, 100), row("2026-11-01", 12, 200), row("2026-11-02", 11, 300), row("2026-11-02", 12, 999)]);
    vi.mocked(loadOrders).mockResolvedValue([]); vi.mocked(loadLines).mockResolvedValue([]);
    const report = await getDashboardReport(store, "live", "2026-11-02");
    expect(report.benchmarks.peak[5]).toBe(300); expect(report.benchmarks.peakDates[5]).toBe("2026-11-02");
    expect(report.benchmarks.peak[6]).toBe(200); expect(report.benchmarks.peakDates[6]).toBe("2026-11-01");
  });
  it("keeps an absent baseline unavailable instead of inventing a percentage", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T04:00:00Z"));
    vi.mocked(loadHours).mockResolvedValue([]); vi.mocked(loadOrders).mockResolvedValue([]); vi.mocked(loadLines).mockResolvedValue([]);
    const report = await getDashboardReport(store, "live", "2026-11-02");
    expect(report.comparison).toBeNull(); expect(report.benchmarks.average).toEqual([]); expect(report.benchmarks.peakDates).toEqual(Array(24).fill(null));
  });
});
