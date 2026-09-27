import { NextRequest } from "next/server";
import { demoAnalytics } from "@/lib/analytics/demo";
import { getDailyAnalytics } from "@/lib/analytics/service";
import { hasSupabaseConfig } from "@/lib/env";
import { businessDateForTimeZone, listStores } from "@/lib/stores";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasSupabaseConfig()) {
    const date = request.nextUrl.searchParams.get("date") || businessDateForTimeZone("Asia/Jakarta");
    return Response.json(demoAnalytics(date), { headers: { "Cache-Control": "no-store" } });
  }

  const stores = await listStores(true);
  const requestedStoreId = request.nextUrl.searchParams.get("store");
  const store = requestedStoreId
    ? stores.find((candidate) => candidate.id === requestedStoreId)
    : stores[0];
  if (!store) return Response.json({ error: "No matching active store was found" }, { status: 404 });

  const date = request.nextUrl.searchParams.get("date") || businessDateForTimeZone(store.timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date must use YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const data = await getDailyAnalytics(store, date, stores);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load analytics";
    return Response.json({ error: message }, { status: 500 });
  }
}
