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
};
