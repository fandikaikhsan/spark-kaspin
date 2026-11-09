import { attendanceDifference, durationText } from "@/lib/staffing/attendance-summary";
import type { ReviewedSession } from "@/lib/staffing/operations-model";
export function AttendanceChips({ session }: { session: ReviewedSession }) {
  const difference = attendanceDifference(session);
  return <span className="ops-attendance-chips">
    {!!difference?.overtimeMinutes && <span className="ops-badge is-overtime" title="Waktu aktual di luar jadwal; dihitung sebagai lembur setelah dikonfirmasi manager.">Lembur {durationText(difference.overtimeMinutes)}</span>}
    {!!difference?.shortMinutes && <span className="ops-badge is-short">Kurang dari jadwal {durationText(difference.shortMinutes)}</span>}
    {session.replaced_staff_name && <span className="ops-badge is-replacement" title={`Menggantikan ${session.replaced_staff_name}`}>Menggantikan {session.replaced_staff_name}</span>}
  </span>;
}
