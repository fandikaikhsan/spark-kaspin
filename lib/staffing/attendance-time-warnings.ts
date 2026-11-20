// Instants are already converted using the work store's timezone.
export function attendanceTimeWarnings(entered: string, exited: string | null, now: Date): string[] {
  const start = Date.parse(entered), end = exited ? Date.parse(exited) : null;
  if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) return [];
  const warnings: string[] = [];
  if (end !== null && end < start) warnings.push("Waktu salah. Jam pulang lebih awal daripada jam masuk.");
  if (end !== null && end - start > 48 * 60 * 60 * 1000) warnings.push("Periksa waktu aktual. Durasi melebihi 48 jam.");
  if (start > now.getTime()) warnings.push("Waktu salah. Jam masuk berada di masa depan.");
  if (end !== null && end > now.getTime()) warnings.push("Waktu salah. Jam pulang berada di masa depan.");
  return warnings;
}
