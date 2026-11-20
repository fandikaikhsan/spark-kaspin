import { ActivityBoard } from "@/components/staffing/activity-board";
import { operationsRpc } from "@/lib/staffing/operations-service";
import { staffingDashboard } from "@/lib/staffing/service";
import { activityWeek } from "@/lib/staffing/activity-view";
import type { ActivityData } from "@/lib/staffing/operations-model";
export const dynamic = "force-dynamic";
export default async function Activities() {
 const base = await staffingDashboard();
 const week = activityWeek(new Date(), base.stores[0]?.time_zone || "Asia/Jakarta");
 const data = await operationsRpc<ActivityData>("staffing_activity_week", { p_store: null, p_week: week });
 return <ActivityBoard initial={data} initialWeek={week} stores={base.stores} canConfigure={base.canConfigure} reports={base.reports.map(report => ({ ...report, full_name: base.sessions.find(session => session.id === report.session_id)?.full_name || "Staff" }))} />;
}
