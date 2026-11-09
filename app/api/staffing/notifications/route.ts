import { operationsRpc } from "@/lib/staffing/operations-service";
import { staffingDashboard, staffingResponse } from "@/lib/staffing/service";
import type { ActivityData } from "@/lib/staffing/operations-model";
import type { NavigationNotifications } from "@/lib/navigation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Both RPCs derive region/store scope from the authenticated account.
    const [activity, dashboard] = await Promise.all([
      operationsRpc<ActivityData>("staffing_activity", { p_store: null, p_day: null }),
      staffingDashboard(),
    ]);
    const items = [
      { id: "shifts", title: "Perubahan shift", description: "Pihak kedua bersedia, menunggu review manager", count: activity.shift_requests?.length || 0, href: "/staffing/activities#review-shifts" },
      { id: "attendance", title: "Absensi hari ini", description: "Menunggu review · tanggal mengikuti lokasi store", count: activity.rows.filter(row => row.session_id && row.verification_state === "pending").length, href: "/staffing/activities#review-attendance" },
      { id: "requests", title: "Pengajuan & pencairan", description: "Izin, sakit, dan kasbon yang perlu ditangani", count: activity.requests.length, href: "/staffing/activities#requests" },
      { id: "reports", title: "Laporan rekan kerja", description: "Laporan absensi yang belum diselesaikan", count: dashboard.reports.length, href: "/staffing/activities#review-reports" },
    ].filter(item => item.count > 0);
    return Response.json({ items, total: items.reduce((sum, item) => sum + item.count, 0) } satisfies NavigationNotifications, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffingResponse(error);
  }
}
