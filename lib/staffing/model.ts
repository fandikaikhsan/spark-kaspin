import { storeOffset } from "../store-timezone";

export type Region = { id: string; name: string };
export type StaffingStore = { id: string; name: string; time_zone: string; active: boolean; region_id: string | null };
export type Staff = { id: string; code: string; full_name: string; home_store_id: string; active: boolean; telegram_linked: boolean };
export type Shift = { replaces_staff_id?: string | null; replaced_staff_name?: string | null; id: string; staff_id: string; store_id: string; label: string; starts_at: string; ends_at: string };
export type AttendanceSession = {
  check_in_reporter_name?: string | null; check_out_reporter_name?: string | null;
  review_version?: string; payroll_locked?: boolean; overtime_from_attendance?: boolean; replaced_staff_name?: string | null;
  id: string; shift_id: string; staff_id: string; full_name: string; store_id: string; label: string;
  starts_at: string; ends_at: string; check_in_at: string; check_out_at: string | null;
  corrected_in_at: string | null; corrected_out_at: string | null;
};
export type StaffingData = {
  canConfigure: boolean; regions: Region[]; stores: StaffingStore[]; staff: Staff[]; shifts: Shift[];
  managers: { id: string; username: string; role: string; active: boolean; region_ids: string[] }[];
  groups: { chat_id: number; store_id: string }[]; sessions: AttendanceSession[];
  reports: { id: string; session_id: string; reporter_name: string; created_at: string }[];
};

export function localTime(value: string, timeZone: string, includeSeconds = false): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" as const } : {}), hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}${includeSeconds ? `:${part("second")}` : ""}`;
}

export function storeInstant(value: unknown, timeZone: string): string {
  const offset = storeOffset(timeZone);
  if (!offset || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error("Invalid store date/time");
  const date = new Date(`${value}${value.length === 16 ? ":00" : ""}${offset}`);
  if (!Number.isFinite(date.getTime()) || localTime(date.toISOString(), timeZone, value.length === 19) !== value) throw new Error("Invalid store date/time");
  return date.toISOString();
}
