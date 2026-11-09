import { describe, it, expect } from "vitest";
import { attendanceDifference } from "@/lib/staffing/attendance-summary";
import { schedulePaint } from "@/lib/staffing/schedule";
function session(entered: string, exited: string | null) { return { starts_at: "2026-11-01T08:00:00+07:00", ends_at: "2026-11-01T16:00:00+07:00", check_in_at: `2026-11-01T${entered}:00+07:00`, check_out_at: exited ? `2026-11-01T${exited}:00+07:00` : null, corrected_in_at: null, corrected_out_at: null }; }
describe("attendance difference and timetable bands", () => {
 it("shows overtime outside the scheduled interval", () => { expect(attendanceDifference(session("08:00", "17:00"))).toEqual({ overtimeMinutes: 60, shortMinutes: 0 }); });
 it("keeps late arrival and late checkout visible separately", () => { expect(attendanceDifference(session("08:30", "16:30"))).toEqual({ overtimeMinutes: 30, shortMinutes: 30 }); });
 it("shows shorter attendance and leaves open sessions undecided", () => { expect(attendanceDifference(session("08:00", "15:00"))?.shortMinutes).toBe(60); expect(attendanceDifference(session("08:00", null))).toBeNull(); });
 it("handles overnight intervals and corrected actual timestamps", () => { const s = { ...session("08:00", "16:00"), starts_at: "2026-11-01T22:00:00+07:00", ends_at: "2026-11-02T06:00:00+07:00", corrected_in_at: "2026-11-01T21:00:00+07:00", corrected_out_at: "2026-11-02T07:00:00+07:00" }; expect(attendanceDifference(s)).toEqual({ overtimeMinutes: 120, shortMinutes: 0 }); });
 it("colors an interval across noon using the matching time proportions", () => { expect(schedulePaint(0, 360).edge).toBe("#252933"); const paint = schedulePaint(690, 750); expect(paint.fill).toContain("#efd05e 50.00%"); expect(paint.fill).toContain("#ed9b42 50.00%"); expect(schedulePaint(1080, 1440).edge).toBe("#c44942"); });
});
