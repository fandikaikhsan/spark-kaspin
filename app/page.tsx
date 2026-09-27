import { Dashboard } from "@/components/dashboard";
import { demoAnalytics } from "@/lib/analytics/demo";
import { getDailyAnalytics } from "@/lib/analytics/service";
import { hasSupabaseConfig } from "@/lib/env";
import { businessDateForTimeZone, listStores } from "@/lib/stores";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!hasSupabaseConfig()) {
    const date = businessDateForTimeZone("Asia/Jakarta");
    return <Dashboard initialData={demoAnalytics(date)} />;
  }

  const stores = await listStores(true);
  if (!stores.length) throw new Error("No active stores are configured. Open /settings to add one.");
  const store = stores[0];
  const date = businessDateForTimeZone(store.timeZone);
  const initialData = await getDailyAnalytics(store, date, stores);

  return <Dashboard initialData={initialData} />;
}
