export const STORE_TIME_ZONES = {
  "Asia/Jakarta": "+07:00",
  "Asia/Makassar": "+08:00",
  "Asia/Jayapura": "+09:00",
} as const;
export type StoreTimeZone = keyof typeof STORE_TIME_ZONES;
export const STORE_ZONE_LABELS: Record<StoreTimeZone, string> = {
  "Asia/Jakarta": "WIB · UTC+7", "Asia/Makassar": "WITA · UTC+8", "Asia/Jayapura": "WIT · UTC+9",
};
export function storeOffset(zone: string): string {
  if (!Object.hasOwn(STORE_TIME_ZONES, zone)) throw new Error("Unsupported store timezone");
  return STORE_TIME_ZONES[zone as StoreTimeZone];
}
export function storeZoneLabel(zone: string): string {
  storeOffset(zone);
  return STORE_ZONE_LABELS[zone as StoreTimeZone];
}
