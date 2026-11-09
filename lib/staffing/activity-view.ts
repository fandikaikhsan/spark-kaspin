import { localTime } from "./model";
import type { ActivityRow, ReviewedSession } from "./operations-model";

export type Presence = "working" | "overdue" | "completed" | "waiting" | "upcoming" | "leave" | "rejected";
export const presenceLabels: Record<Presence, string> = {
  working: "Sedang bekerja", overdue: "Belum checkout", completed: "Sudah checkout", waiting: "Belum check-in",
  upcoming: "Belum mulai", leave: "Izin disetujui", rejected: "Absensi ditolak",
};
export function presenceOf(row: ActivityRow, now: number): Presence {
  if (row.verification_state === "rejected") return "rejected";
  if (row.corrected_out_at || row.check_out_at) return "completed";
  if (row.corrected_in_at || row.check_in_at) return now > Date.parse(row.ends_at) ? "overdue" : "working";
  if (row.approved_leave) return "leave";
  return Date.parse(row.starts_at) > now ? "upcoming" : "waiting";
}
export function activityPriority(row: ActivityRow, now: number): number {
  if (row.verification_state === "pending") return 0;
  const state = presenceOf(row, now);
  return { overdue: 1, waiting: 2, working: 3, upcoming: 4, leave: 5, completed: 6, rejected: 7 }[state];
}
export function attendanceMatches(session: ReviewedSession, filters: { query: string; review: string; from: string; to: string }): boolean {
  const day = localTime(session.starts_at, session.time_zone).slice(0, 10);
  const text = `${session.label} ${session.store_name} ${day}`.toLocaleLowerCase("id-ID");
  return text.includes(filters.query.trim().toLocaleLowerCase("id-ID")) &&
    (filters.review === "all" || session.verification_state === filters.review) &&
    (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
}
