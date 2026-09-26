import { Dashboard } from "@/components/dashboard";
import { demoAnalytics } from "@/lib/analytics/demo";
import { getDailyAnalytics } from "@/lib/analytics/service";
import { hasSupabaseConfig } from "@/lib/env";
import { currentBusinessDate } from "@/lib/sync";

export const dynamic = "force-dynamic";

export default async function Home() {
  const date = currentBusinessDate();
  const initialData = hasSupabaseConfig()
    ? await getDailyAnalytics(date)
    : demoAnalytics(date);

  return <Dashboard initialData={initialData} />;
}
