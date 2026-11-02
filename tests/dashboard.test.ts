import { describe, expect, it } from "vitest";
import { addDays, averageOrderValue, isBusinessDate, localClock, businessClock, businessWindow, businessHourIndex, withinBusinessTime, BUSINESS_HOURS, percentageChange, productSales, reportingPeriod, trailingAverage } from "@/lib/analytics/dashboard";
import { salesBenchmarks } from "@/lib/analytics/benchmarks";
import type { HourlyItemSale } from "@/lib/analytics/types";

describe("dashboard reporting periods", () => {
  it("uses the selected store's local date and hour, including midnight", () => {
    const instant = new Date("2026-10-23T16:05:00Z");
    expect(localClock("Asia/Makassar", instant)).toEqual({ date: "2026-10-24", hour: 0, time: "00:05:00" });
    expect(localClock("Asia/Jakarta", instant)).toEqual({ date: "2026-10-23", hour: 23, time: "23:05:00" });
  });
  it("compares against the seven previous complete business days", () => {
    expect(reportingPeriod("live", "2026-10-24", "2026-10-24")).toEqual({ start: "2026-10-24", end: "2026-10-24", comparisonStart: "2026-10-17", comparisonEnd: "2026-10-23" });
    expect(addDays("2026-01-01", -7)).toBe("2025-12-25");
  });
  it("compares month-to-date with matching elapsed dates, across years and unequal month lengths", () => {
    expect(reportingPeriod("monthly", "2026-10-01", "2026-10-24")).toEqual({ start: "2026-10-01", end: "2026-10-24", comparisonStart: "2026-09-01", comparisonEnd: "2026-09-24" });
    expect(reportingPeriod("monthly", "2026-03-01", "2026-03-30").comparisonEnd).toBe("2026-02-28");
    expect(reportingPeriod("monthly", "2026-01-10", "2026-01-15").comparisonStart).toBe("2025-12-01");
    expect(reportingPeriod("monthly", "2026-09-01", "2026-10-24").end).toBe("2026-09-30");
  });
  it("rejects impossible dates and future selections", () => {
    expect(isBusinessDate("2026-02-31")).toBe(false);
    expect(isBusinessDate("2026-13-01")).toBe(false);
    expect(isBusinessDate("2024-02-29")).toBe(true);
    expect(() => reportingPeriod("daily", "2026-10-25", "2026-10-24")).toThrow();
  });
});

describe("06:00 reporting and comparison curves", () => {
  it("moves early-morning sales to the prior business day without changing the ingestion clock", () => {
    const instant = new Date("2026-01-01T21:59:59Z");
    expect(localClock("Asia/Makassar", instant).date).toBe("2026-01-02");
    expect(businessClock("Asia/Makassar", instant)).toMatchObject({ date: "2026-01-01", hour: 5, hourIndex: 23 });
    expect(businessClock("Asia/Makassar", new Date("2026-01-01T22:00:00Z"))).toMatchObject({ date: "2026-01-02", hourIndex: 0 });
    expect(businessWindow("2026-12-31", "2026-12-31", "+07:00")).toEqual({ from: "2026-12-31T06:00:00+07:00", until: "2027-01-01T06:00:00+07:00" });
    expect(BUSINESS_HOURS).toEqual([6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5]);
    expect(businessHourIndex(0)).toBeGreaterThan(businessHourIndex(23));
  });
  it("cuts every comparison day at the same elapsed time, including after midnight", () => {
    expect(withinBusinessTime("2026-10-20T23:00:00+08:00", "2026-10-20", "+08:00", "00:30:00")).toBe(true);
    expect(withinBusinessTime("2026-10-21T00:30:00+08:00", "2026-10-20", "+08:00", "00:30:00")).toBe(true);
    expect(withinBusinessTime("2026-10-21T00:30:01+08:00", "2026-10-20", "+08:00", "00:30:00")).toBe(false);
    expect(withinBusinessTime("2026-10-20T05:59:59+08:00", "2026-10-20", "+08:00", "18:00:00")).toBe(false);
  });
  it("uses one real best day and divides hourly totals by seven, not the number of sales rows", () => {
    const row = (date: string, hour: number, revenue: number) => ({ date, hour, revenue, quantity: 1, itemCode: "A", itemName: "A", category: "Food" });
    const result = salesBenchmarks([row("2026-10-01", 6, 100), row("2026-10-01", 7, 5), row("2026-10-02", 6, 1), row("2026-10-02", 7, 90), row("2026-10-17", 0, 70), row("2026-10-24", 6, 999)], "live", "2026-10-24", "2026-10-24", "2026-10-17", "2026-10-23");
    expect(result.bestDate).toBe("2026-10-01"); expect(result.best.slice(0, 2)).toEqual([100, 5]);
    expect(result.average[18]).toBe(10); expect(result.average[0]).toBe(0);
    expect(salesBenchmarks([], "live", "2026-10-24", "2026-10-24", "2026-10-17", "2026-10-23").bestDate).toBeNull();
  });
  it("leaves missing calendar days as gaps when aligning unequal months", () => {
    const rows = [{ date: "2026-02-01", hour: 6, revenue: 100, quantity: 1, itemCode: "A", itemName: "A", category: "Food" }];
    const result = salesBenchmarks(rows, "monthly", "2026-03-01", "2026-03-31", "2026-02-01", "2026-02-28");
    expect(result.average[0]).toBe(100); expect(result.average.slice(28)).toEqual([null, null, null]);
  });
});

describe("dashboard figures", () => {
  it("ranks products by sales amount, aggregates repeated hours, and keeps all products for the pie denominator", () => {
    const row = (itemCode: string, hour: number, quantity: number, revenue: number): HourlyItemSale => ({ itemCode, itemName: itemCode, category: "Food", hour, quantity, revenue });
    const products = productSales([row("High quantity", 8, 100, 50), row("High sales", 8, 1, 70), row("High sales", 8, 2, 30), row("Third", 9, 1, 10), row("Fourth", 10, 1, 9), row("Other", 10, 1, 8)]);
    expect(products.map((product) => product.code)).toEqual(["High sales", "High quantity", "Third", "Fourth", "Other"]);
    expect(products[0]).toMatchObject({ revenue: 100, units: 3 });
    expect(products[0].hours[8]).toBe(3);
    expect(products.reduce((total, product) => total + product.revenue, 0)).toBe(177);
  });
  it("doesn't invent percentage changes or average order values for missing baselines", () => {
    expect(percentageChange(100, null)).toBeNull();
    expect(percentageChange(100, 0)).toBeNull();
    expect(percentageChange(0, 100)).toBe(-100);
    expect(percentageChange(75, 100)).toBe(-25);
    expect(averageOrderValue({ transactions: 0, revenue: 0, units: 0 })).toBeNull();
    expect(averageOrderValue({ transactions: 200, revenue: 6_040_000, units: 480 })).toBe(30_200);
  });
  it("starts seven-day averages only when a complete seven-day window exists", () => {
    expect(trailingAverage([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([null, null, null, null, null, null, 4, 5]);
  });
});
