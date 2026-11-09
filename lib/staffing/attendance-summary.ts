import type { ReviewedSession } from "./operations-model";
export function attendanceDifference(session: Pick<ReviewedSession, "starts_at" | "ends_at" | "check_in_at" | "check_out_at" | "corrected_in_at" | "corrected_out_at">) {
  const start = Date.parse(session.starts_at), end = Date.parse(session.ends_at);
  const entered = Date.parse(session.corrected_in_at || session.check_in_at);
  const out = session.corrected_out_at || session.check_out_at;
  if (!out) return null;
  const exited = Date.parse(out);
  if (![start, end, entered, exited].every(Number.isFinite) || exited < entered) return null;
  const overlap = Math.max(0, Math.min(end, exited) - Math.max(start, entered));
  return { overtimeMinutes: Math.round((exited - entered - overlap) / 60000), shortMinutes: Math.round((end - start - overlap) / 60000) };
}
export function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return [hours ? `${hours}j` : "", remainder ? `${remainder}m` : ""].filter(Boolean).join(" ") || "0m";
}
