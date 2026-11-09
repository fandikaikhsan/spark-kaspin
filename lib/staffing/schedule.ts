import { storeInstant, type Staff, type StaffingStore, type Shift } from "@/lib/staffing/model";

export const DAY_MINUTES = 1440;
export const WEEK_MINUTES = 7 * DAY_MINUTES;
export const SNAP_MINUTES = 30;
export type ScheduledShift = Shift & { full_name: string; locked: boolean; editable: boolean };
export type BusyShift = Pick<Shift, "id" | "staff_id" | "starts_at" | "ends_at">;
export type ScheduleWeek = {
  store: StaffingStore;
  week_start: string;
  version: string;
  staff: Staff[];
  shifts: ScheduledShift[];
  busy: BusyShift[];
};
export type PlanShift = ScheduledShift & { persisted: boolean };
export type ShiftFragment = { shift: PlanShift; day: number; start: number; end: number; lane: number; lanes: number; continued: boolean; continues: boolean };

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}
export function validMonday(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}
const origins = new Map<string, number>();
export function weekOrigin(week: string, zone: string): number {
  const key = `${week}/${zone}`;
  const cached = origins.get(key);
  if (cached !== undefined) return cached;
  const value = Date.parse(storeInstant(`${week}T00:00`, zone));
  if (origins.size >= 64) origins.clear();
  origins.set(key, value);
  return value;
}
export function shiftRange(shift: BusyShift, week: string, zone: string): [number, number] {
  const origin = weekOrigin(week, zone);
  return [(Date.parse(shift.starts_at) - origin) / 60000, (Date.parse(shift.ends_at) - origin) / 60000];
}
export function clippedMinutes(shift: BusyShift, week: string, zone: string): number {
  const [start, end] = shiftRange(shift, week, zone);
  return Math.max(0, Math.min(WEEK_MINUTES, end) - Math.max(0, start));
}
export function allocation(staffId: string, shifts: BusyShift[], week: string, zone: string) {
  const own = shifts.filter((shift) => shift.staff_id === staffId);
  const days = Array.from({ length: 7 }, (_, day) => day).filter((day) => own.some((shift) => {
    const [start, end] = shiftRange(shift, week, zone);
    return start < (day + 1) * DAY_MINUTES && end > day * DAY_MINUTES;
  }));
  return { minutes: own.reduce((total, shift) => total + clippedMinutes(shift, week, zone), 0), days };
}
export function moveShift(shift: PlanShift, start: number, end: number, week: string, zone: string): PlanShift {
  const origin = weekOrigin(week, zone);
  return { ...shift, starts_at: new Date(origin + start * 60000).toISOString(), ends_at: new Date(origin + end * 60000).toISOString() };
}
export function conflictFor(candidate: BusyShift, draft: BusyShift[], busy: BusyShift[]): boolean {
  return [...draft, ...busy].some((other) => other.id !== candidate.id && other.staff_id === candidate.staff_id && Date.parse(other.starts_at) < Date.parse(candidate.ends_at) && Date.parse(other.ends_at) > Date.parse(candidate.starts_at));
}
export function validPlacement(candidate: PlanShift, draft: PlanShift[], busy: BusyShift[], week: string, zone: string): string | null {
  const [start, end] = shiftRange(candidate, week, zone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= WEEK_MINUTES) return "Mulai shift harus berada dalam minggu yang dipilih.";
  if (end - start < SNAP_MINUTES || end - start > DAY_MINUTES) return "Durasi shift harus antara 30 menit dan 24 jam.";
  if (conflictFor(candidate, draft, busy)) return "Staff ini sudah memiliki penugasan pada waktu tersebut.";
  return null;
}
export function plannerDirty(draft: PlanShift[], initial: PlanShift[]): boolean {
  const signature = (rows: PlanShift[]) => JSON.stringify(rows.map(({ id, staff_id, label, starts_at, ends_at }) => [id, staff_id, label, Date.parse(starts_at), Date.parse(ends_at)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return signature(draft) !== signature(initial);
}
export function fragments(shifts: PlanShift[], week: string, zone: string): ShiftFragment[] {
  const result: ShiftFragment[] = [];
  for (let day = 0; day < 7; day++) {
    const pieces: ShiftFragment[] = [];
    for (const shift of shifts) {
      const [start, end] = shiftRange(shift, week, zone);
      const from = Math.max(0, start - day * DAY_MINUTES);
      const to = Math.min(DAY_MINUTES, end - day * DAY_MINUTES);
      if (from < to) pieces.push({ shift, day, start: from, end: to, lane: 0, lanes: 1, continued: start < day * DAY_MINUTES, continues: end > (day + 1) * DAY_MINUTES });
    }
    pieces.sort((a, b) => a.start - b.start || b.end - a.end || a.shift.id.localeCompare(b.shift.id));
    let cluster: ShiftFragment[] = [];
    let laneEnds: number[] = [];
    let clusterEnd = -1;
    const flush = () => { for (const piece of cluster) { piece.lanes = laneEnds.length; result.push(piece); } cluster = []; laneEnds = []; };
    for (const piece of pieces) {
      if (piece.start >= clusterEnd) flush();
      let lane = laneEnds.findIndex((end) => end <= piece.start);
      if (lane === -1) lane = laneEnds.length;
      piece.lane = lane; laneEnds[lane] = piece.end; cluster.push(piece);
      clusterEnd = Math.max(...laneEnds);
    }
    flush();
  }
  return result;
}

export type RandomOptions = { targetMinutes: number; duration: number; startMinute: number; days: number[] };
export function fillToTarget(
  draft: PlanShift[], busy: BusyShift[], staff: Staff[], storeId: string,
  week: string, zone: string, options: RandomOptions, random: () => number = Math.random,
): PlanShift[] {
  if (!options.days.length || options.duration < SNAP_MINUTES || options.duration > DAY_MINUTES || options.startMinute < 0 || options.startMinute >= DAY_MINUTES || options.targetMinutes <= 0) return draft;
  const shuffle = <T,>(items: T[]): T[] => {
    const output = [...items];
    for (let index = output.length - 1; index > 0; index--) { const next = Math.floor(random() * (index + 1)); [output[index], output[next]] = [output[next], output[index]]; }
    return output;
  };
  const output = [...draft];
  for (const person of shuffle(staff.filter((s) => s.active))) {
    let remaining = options.targetMinutes - allocation(person.id, [...output, ...busy], week, zone).minutes;
    for (const day of shuffle([...new Set(options.days)].filter((d) => Number.isInteger(d) && d >= 0 && d < 7))) {
      if (remaining < SNAP_MINUTES) break;
      // Avoid splitting a person's working day automatically. Manual placement can
      // still express split shifts when the manager deliberately schedules them.
      if ([...output, ...busy].some((existing) => {
        if (existing.staff_id !== person.id) return false;
        const [from] = shiftRange(existing, week, zone);
        return from >= day * DAY_MINUTES && from < (day + 1) * DAY_MINUTES;
      })) continue;
      const duration = Math.floor(Math.min(options.duration, remaining) / SNAP_MINUTES) * SNAP_MINUTES;
      const start = day * DAY_MINUTES + options.startMinute;
      const candidate = moveShift({ id: `draft-${crypto.randomUUID()}`, staff_id: person.id, store_id: storeId, label: "Shift", starts_at: "", ends_at: "", full_name: person.full_name, editable: true, locked: false, persisted: false }, start, start + duration, week, zone);
      if (validPlacement(candidate, output, busy, week, zone)) continue;
      output.push(candidate);
      remaining -= clippedMinutes(candidate, week, zone);
    }
  }
  return output;
}
const clocks = new Map<string, Intl.DateTimeFormat>();
export function timeLabel(value: string, zone: string): string {
  let formatter = clocks.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); clocks.set(zone, formatter); }
  return formatter.format(new Date(value));
}
export function hoursLabel(minutes: number): string { return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(minutes / 60); }

export const SCHEDULE_BANDS = [
  { from: 0, to: 360, label: "00–06 · Subuh", color: "#252933" },
  { from: 360, to: 720, label: "06–12 · Pagi", color: "#efd05e" },
  { from: 720, to: 1080, label: "12–18 · Siang", color: "#ed9b42" },
  { from: 1080, to: 1440, label: "18–24 · Malam", color: "#c44942" },
];
export function schedulePaint(from: number, to: number) {
  const segments = SCHEDULE_BANDS.filter(band => band.from < to && band.to > from);
  const stops = segments.flatMap(band => [
    `${band.color} ${((Math.max(from, band.from) - from) / (to - from) * 100).toFixed(2)}%`,
    `${band.color} ${((Math.min(to, band.to) - from) / (to - from) * 100).toFixed(2)}%`,
  ]);
  return { edge: segments[0]?.color || "#252933", fill: `linear-gradient(to bottom, ${stops.join(", ")})` };
}
