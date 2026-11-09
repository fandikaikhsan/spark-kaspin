import { describe, expect, it } from "vitest";
import { activityPriority, attendanceMatches, presenceOf } from "@/lib/staffing/activity-view";
import type { ActivityRow, ReviewedSession } from "@/lib/staffing/operations-model";
const now = Date.parse("2026-11-07T06:00:00Z");
function row(extra: Partial<ActivityRow> = {}): ActivityRow {
  return { id: "shift", staff_id: "staff", store_id: "store", label: "Opening", starts_at: "2026-11-07T01:00:00Z", ends_at: "2026-11-07T09:00:00Z", full_name: "Staff demo", store_name: "Jatinangor", time_zone: "Asia/Jakarta", can_view_profile: true, session_id: null, check_in_at: null, check_out_at: null, corrected_in_at: null, corrected_out_at: null, verification_state: null, review_note: null, reviewed_at: null, approved_leave: false, last_location: null, ...extra };
}
function session(): ReviewedSession {
  return { ...row(), id: "session", shift_id: "shift", check_in_at: "2026-11-07T01:00:00Z", verification_state: "confirmed" };
}
describe("activity presence and attendance filtering", () => {
  it("distinguishes future shifts and missing check-in without declaring absence", () => {
    expect(presenceOf(row({ starts_at: "2026-11-07T07:00:00Z" }), now)).toBe("upcoming");
    expect(presenceOf(row(), now)).toBe("waiting");
  });
  it("keeps physical presence separate from verification and prioritizes pending review", () => {
    const pending = row({ session_id: "session", check_in_at: "2026-11-07T01:00:00Z", verification_state: "pending" });
    expect(presenceOf(pending, now)).toBe("working"); expect(activityPriority(pending, now)).toBe(0);
    expect(presenceOf({ ...pending, check_out_at: "2026-11-07T05:00:00Z" }, now)).toBe("completed");
  });
  it("uses corrections and excludes rejected attendance from working counts", () => {
    const corrected = row({ check_in_at: "2026-11-07T01:00:00Z", corrected_out_at: "2026-11-07T05:30:00Z", verification_state: "confirmed" });
    expect(presenceOf(corrected, now)).toBe("completed");
    expect(presenceOf({ ...corrected, verification_state: "rejected" }, now)).toBe("rejected");
    expect(presenceOf(row({ approved_leave: true }), now)).toBe("leave");
  });
  it("prioritizes overdue open sessions over shifts that have not started", () => {
    const overdue = row({ check_in_at: "2026-11-07T01:00:00Z", ends_at: "2026-11-07T05:00:00Z", verification_state: "confirmed" });
    expect(presenceOf(overdue, now)).toBe("overdue");
    expect(activityPriority(overdue, now)).toBeLessThan(activityPriority(row({ starts_at: "2026-11-07T07:00:00Z" }), now));
  });
  it("filters local schedule dates at UTC day boundaries in the work-store timezone", () => {
    const night = { ...session(), starts_at: "2026-11-06T17:00:00Z", time_zone: "Asia/Makassar" };
    expect(attendanceMatches(night, { query: "", review: "all", from: "2026-11-07", to: "2026-11-07" })).toBe(true);
    expect(attendanceMatches(night, { query: "", review: "all", from: "", to: "2026-11-06" })).toBe(false);
  });
  it("combines search, review status and inclusive dates", () => {
    expect(attendanceMatches(session(), { query: "  JATINANGOR  ", review: "confirmed", from: "2026-11-07", to: "2026-11-07" })).toBe(true);
    expect(attendanceMatches(session(), { query: "Opening", review: "pending", from: "", to: "" })).toBe(false);
    expect(attendanceMatches(session(), { query: "Closing", review: "all", from: "", to: "" })).toBe(false);
  });
});
