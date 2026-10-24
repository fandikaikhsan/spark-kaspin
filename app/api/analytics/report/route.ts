import { NextRequest } from "next/server";
import { hasSupabaseConfig } from "@/lib/env";
import { isBusinessDate, localClock } from "@/lib/analytics/dashboard";
import { demoDashboardReport, getDashboardReport } from "@/lib/analytics/report";
import { listStores } from "@/lib/stores";
import type { DashboardMode } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "daily";
  const date = request.nextUrl.searchParams.get("date") || localClock("Asia/Jakarta").date;
  if (!["live", "daily", "monthly"].includes(mode) || !isBusinessDate(date)) {
    return Response.json({ error: "Choose a valid view and date" }, { status: 400 });
  }
  try {
    if (!hasSupabaseConfig()) return Response.json(demoDashboardReport(mode as DashboardMode, date));
    const stores = await listStores(true);
    const id = request.nextUrl.searchParams.get("store");
    const store = id ? stores.find((store) => store.id === id) : stores[0];
    if (!store) return Response.json({ error: "Store not found" }, { status: 404 });
    if (date > localClock(store.timeZone).date) return Response.json({ error: "Choose today or an earlier date" }, { status: 400 });
    return Response.json(await getDashboardReport(store, mode as DashboardMode, date), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load report" }, { status: 500 });
  }
}
