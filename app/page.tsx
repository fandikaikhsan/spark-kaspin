import { Dashboard } from "@/components/dashboard";
import { demoAnalytics } from "@/lib/analytics/demo";
import { getDailyAnalytics } from "@/lib/analytics/service";
import { hasSupabaseConfig } from "@/lib/env";
import { businessDateForTimeZone, listStores } from "@/lib/stores";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { isBusinessDate } from "@/lib/analytics/dashboard";
import type { DashboardMode } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ store?: string; date?: string; view?: string }> }) {
  const parameters = await searchParams;
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  const user = session ? { username: session.username, role: session.role } : undefined;
  const mode: DashboardMode = parameters.view === "monthly" || parameters.view === "daily" ? parameters.view : "live";
  if (!hasSupabaseConfig()) {
    const today = businessDateForTimeZone("Asia/Jakarta");
    const date = mode !== "live" && parameters.date && isBusinessDate(parameters.date) && parameters.date <= today ? parameters.date : today;
    return <Dashboard initialData={demoAnalytics(date)} initialMode={mode} initialNow={Date.now()} user={user} />;
  }

  const stores = await listStores(true);
  if (!stores.length) throw new Error("No active stores are configured. Open /settings to add one.");
  const store = stores.find((store) => store.id === parameters.store) || stores[0];
  const today = businessDateForTimeZone(store.timeZone);
  const date = mode !== "live" && parameters.date && isBusinessDate(parameters.date) && parameters.date <= today ? parameters.date : today;
  const initialData = await getDailyAnalytics(store, date, stores);

  return <Dashboard initialData={initialData} initialMode={mode} initialNow={Date.now()} user={user} />;
}
