import { refreshIntervalSeconds } from "@/lib/env";
import type { DailyAnalytics } from "./types";

export function demoAnalytics(date: string): DailyAnalytics {
  return {
    date,
    source: "demo",
    transactionCount: 1,
    totalUnits: 7,
    totalRevenue: 182_724,
    refreshSeconds: refreshIntervalSeconds(),
    lastSyncedAt: null,
    hourlyItems: [
      { itemCode: "NSP008", itemName: "Nasi Creamy Beef Shortplate", category: "01 spesial sarkop", hour: 0, quantity: 3, revenue: 95_454 },
      { itemCode: "NSP007", itemName: "Nasi Telur Krispi Sarkop", category: "01 spesial sarkop", hour: 0, quantity: 1, revenue: 18_181 },
      { itemCode: "NGR003", itemName: "Nasi Goreng Rempah Telur + Ayam Suwir", category: "02 nasi goreng", hour: 0, quantity: 1, revenue: 25_454 },
      { itemCode: "NSP001", itemName: "Nasi Spesial Sarkop", category: "01 spesial sarkop", hour: 0, quantity: 1, revenue: 24_545 },
      { itemCode: "MIS001", itemName: "Teh Susu Creamy", category: "08 minuman spesial", hour: 0, quantity: 1, revenue: 19_090 },
    ],
  };
}
