import { attendanceDifference, durationText } from "@/lib/staffing/attendance-summary";
import type { ReviewedSession } from "@/lib/staffing/operations-model";
export function AttendanceChips({ session }: { session: ReviewedSession }) {
  const difference = session.is_unscheduled ? null : attendanceDifference(session);
  return <span className="ops-attendance-chips">
    {(session.shared_evidence_count || 0) > 1 && <span className="ops-badge">Bukti bersama {session.shared_evidence_count} staf</span>}
    {session.overtime_only && <span className="ops-badge is-overtime">Lembur disetujui</span>}
    {session.is_unscheduled && <span className="ops-badge is-pending">Masuk di luar jadwal</span>}
    {(session.check_in_reporter_name || session.check_out_reporter_name) && <span className="ops-badge is-replacement" title={`Masuk: ${session.check_in_reporter_name || "sendiri"}; pulang: ${session.check_out_reporter_name || "sendiri"}`}>Diwakili {session.check_in_reporter_name || session.check_out_reporter_name}</span>}
    {!!difference?.overtimeMinutes && <span className="ops-badge is-overtime" title="Waktu aktual di luar jadwal; perlu pengajuan lembur dan persetujuan manager sebelum dibayar.">Kelebihan waktu {durationText(difference.overtimeMinutes)}</span>}
    {!!difference?.shortMinutes && <span className="ops-badge is-short">Kurang dari jadwal {durationText(difference.shortMinutes)}</span>}
    {session.replaced_staff_name && <span className="ops-badge is-replacement" title={`Menggantikan ${session.replaced_staff_name}`}>Menggantikan {session.replaced_staff_name}</span>}
  </span>;
}
