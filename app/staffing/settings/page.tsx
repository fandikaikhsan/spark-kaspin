import { redirect } from "next/navigation";
import { StaffingSettings } from "@/components/staffing/settings";
import { staffingDashboard } from "@/lib/staffing/service";
import { listStoreAdminSummaries } from "@/lib/store-admin";
import { listUsers } from "@/lib/users";
export const dynamic = "force-dynamic";
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; staff?: string }> }) {
  const data = await staffingDashboard();
  if (!data.canConfigure) redirect("/staffing");
  const [stores, users, query] = await Promise.all([listStoreAdminSummaries(), listUsers(), searchParams]);
  return <StaffingSettings data={data} initialStores={stores} initialUsers={users} section={query.section} staffId={query.staff}
    bot={{ username: process.env.STAFFING_TELEGRAM_BOT_USERNAME?.trim() || null, configured: !!process.env.STAFFING_TELEGRAM_BOT_TOKEN?.trim() }} />;
}
