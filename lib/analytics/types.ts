export type HourlyItemSale = {
  itemCode: string;
  itemName: string;
  category: string;
  hour: number;
  quantity: number;
  revenue: number;
};

export type DailyAnalytics = {
  date: string;
  source: "supabase" | "demo";
  transactionCount: number;
  totalUnits: number;
  totalRevenue: number;
  refreshSeconds: number;
  lastSyncedAt: string | null;
  hourlyItems: HourlyItemSale[];
};
