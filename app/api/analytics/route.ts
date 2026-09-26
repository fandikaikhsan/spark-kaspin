import { NextRequest } from "next/server";
import { demoAnalytics } from "@/lib/analytics/demo";
import { getDailyAnalytics } from "@/lib/analytics/service";
import { hasSupabaseConfig } from "@/lib/env";
import { currentBusinessDate } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date") || currentBusinessDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date must use YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const data = hasSupabaseConfig() ? await getDailyAnalytics(date) : demoAnalytics(date);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load analytics";
    return Response.json({ error: message }, { status: 500 });
  }
}
