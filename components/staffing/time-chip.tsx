import { localTime } from "@/lib/staffing/model";
import { SCHEDULE_BANDS } from "@/lib/staffing/schedule";

export function TimeChip({ value, zone, clockOnly = false }: { value: string; zone: string; clockOnly?: boolean }) {
  const [date, clock] = localTime(value, zone).split("T");
  const [year, month, day] = date.split("-");
  const [hour, minute] = clock.split(":").map(Number);
  const minutes = hour * 60 + minute;
  const band = SCHEDULE_BANDS.find(item => minutes >= item.from && minutes < item.to)!;
  const fullLabel = `${day}/${month}/${year} ${clock}`;
  const dark = band.from === 0 || band.from >= 1080;
  return <time className="ops-time-chip" dateTime={value} title={fullLabel} aria-label={fullLabel}
    style={{ background: band.color, color: dark ? "#fff" : "#263226" }}>{clockOnly ? clock : fullLabel}</time>;
}
