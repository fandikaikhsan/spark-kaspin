import { refreshIntervalSeconds } from "@/lib/env";
import type { DailyAnalytics, TransactionPage } from "./types";

export function demoAnalytics(date: string): DailyAnalytics {
  const store = {
    id: "demo-store",
    name: "Demo store",
    timeZone: "Asia/Jakarta",
    utcOffset: "+07:00",
    businessDate: date,
  };
  return {
    date,
    source: "demo",
    store,
    stores: [store],
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
    recentTransactions: [{
      transactionCode: "DEMO-001",
      receiptNumber: 1388,
      businessDate: date,
      occurredAt: `${date}T00:14:03+07:00`,
      subtotal: 182_724,
      grandTotal: 182_724,
      paymentType: "tunai",
      items: [
        { lineNumber: 0, itemCode: "NSP008", itemName: "Nasi Creamy Beef Shortplate", category: "01 spesial sarkop", quantity: 3, returnedQuantity: 0, grossSales: 95_454 },
        { lineNumber: 1, itemCode: "NSP007", itemName: "Nasi Telur Krispi Sarkop", category: "01 spesial sarkop", quantity: 1, returnedQuantity: 0, grossSales: 18_181 },
        { lineNumber: 2, itemCode: "NGR003", itemName: "Nasi Goreng Rempah Telur + Ayam Suwir", category: "02 nasi goreng", quantity: 1, returnedQuantity: 0, grossSales: 25_454 },
        { lineNumber: 3, itemCode: "NSP001", itemName: "Nasi Spesial Sarkop", category: "01 spesial sarkop", quantity: 1, returnedQuantity: 0, grossSales: 24_545 },
        { lineNumber: 4, itemCode: "MIS001", itemName: "Teh Susu Creamy", category: "08 minuman spesial", quantity: 1, returnedQuantity: 0, grossSales: 19_090 },
      ],
    }],
  };
}

export function demoTransactionPage(date: string): TransactionPage {
  const analytics = demoAnalytics(date);
  return {
    date,
    store: analytics.store,
    stores: analytics.stores,
    transactions: [...analytics.recentTransactions].reverse(),
    page: 1,
    pageSize: 20,
    totalCount: analytics.recentTransactions.length,
    totalPages: 1,
  };
}
