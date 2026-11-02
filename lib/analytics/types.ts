export type HourlyItemSale = {
  itemCode: string;
  itemName: string;
  category: string;
  hour: number;
  quantity: number;
  revenue: number;
};

export type AnalyticsStore = {
  id: string;
  name: string;
  timeZone: string;
  utcOffset: string;
  businessDate: string;
};

export type TransactionItem = {
  lineNumber: number;
  itemCode: string;
  itemName: string;
  category: string;
  quantity: number;
  returnedQuantity: number;
  grossSales: number;
};

export type TransactionReceipt = {
  transactionCode: string;
  receiptNumber: number;
  businessDate: string;
  occurredAt: string;
  subtotal: number;
  grandTotal: number;
  paymentType: string;
  items: TransactionItem[];
};

export type TransactionPage = {
  date: string;
  store: AnalyticsStore;
  stores: AnalyticsStore[];
  transactions: TransactionReceipt[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

export type DailyAnalytics = {
  date: string;
  source: "supabase" | "demo";
  store: AnalyticsStore;
  stores: AnalyticsStore[];
  transactionCount: number;
  totalUnits: number;
  totalRevenue: number;
  refreshSeconds: number;
  lastSyncedAt: string | null;
  hourlyItems: HourlyItemSale[];
  recentTransactions: TransactionReceipt[];
};

export type DashboardMode = "live" | "daily" | "monthly";

export type DatedHourlyItemSale = HourlyItemSale & { date: string };
export type DashboardTotals = {
  revenue: number;
  units: number;
  transactions: number;
};
export type DashboardReport = {
  date: string;
  mode: DashboardMode;
  storeId: string;
  source: "supabase" | "demo";
  startDate: string;
  endDate: string;
  hourlyItems: DatedHourlyItemSale[];
  daily: (DashboardTotals & { date: string })[];
  baskets: { label: string; count: number }[];
  weekdayHours: { weekday: number; occurrences: number; hours: number[] }[];
  comparison: DashboardTotals | null;
  comparisonStart: string;
  comparisonEnd: string;
  comparisonThrough: string | null;
  benchmarks: {
    average: (number | null)[];
    averageLabel: string;
    peak: (number | null)[];
    peakDates: (string | null)[];
  };
};
