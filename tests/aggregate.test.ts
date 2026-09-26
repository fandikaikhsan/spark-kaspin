import { describe, expect, it } from "vitest";
import { hottestItem, summarizeHourlyItems } from "@/lib/analytics/aggregate";
import type { HourlyItemSale } from "@/lib/analytics/types";

const rows: HourlyItemSale[] = [
  { itemCode: "A", itemName: "Coffee", category: "Drink", hour: 8, quantity: 2, revenue: 20 },
  { itemCode: "A", itemName: "Coffee", category: "Drink", hour: 9, quantity: 3, revenue: 30 },
  { itemCode: "B", itemName: "Toast", category: "Food", hour: 8, quantity: 4, revenue: 80 },
];

describe("daily analytics aggregation", () => {
  it("sums hourly units and revenue", () => {
    expect(summarizeHourlyItems(rows)).toEqual({ totalUnits: 9, totalRevenue: 130 });
  });

  it("selects the top item across all hours", () => {
    expect(hottestItem(rows)).toMatchObject({ itemCode: "A", quantity: 5, revenue: 50 });
  });
});
