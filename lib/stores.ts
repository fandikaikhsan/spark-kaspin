import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const STORE_TIME_ZONES = {
  "Asia/Jakarta": "+07:00",
  "Asia/Makassar": "+08:00",
} as const;

export type StoreTimeZone = keyof typeof STORE_TIME_ZONES;

export type Store = {
  id: string;
  name: string;
  timeZone: StoreTimeZone;
  utcOffset: string;
  isDefault: boolean;
  active: boolean;
};

type StoreRow = {
  id: string;
  name: string;
  time_zone: StoreTimeZone;
  utc_offset: string;
  is_default: boolean;
  active: boolean;
};

function fromRow(row: StoreRow): Store {
  return {
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    utcOffset: row.utc_offset,
    isDefault: row.is_default,
    active: row.active,
  };
}

export function businessDateForTimeZone(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function listStores(activeOnly = false): Promise<Store[]> {
  let query = getSupabaseAdmin()
    .from("stores")
    .select("id,name,time_zone,utc_offset,is_default,active")
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  if (activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new Error(`Could not load stores: ${error.message}`);
  return ((data || []) as StoreRow[]).map(fromRow);
}

export async function getStore(storeId: string): Promise<Store> {
  const { data, error } = await getSupabaseAdmin()
    .from("stores")
    .select("id,name,time_zone,utc_offset,is_default,active")
    .eq("id", storeId)
    .single();

  if (error) throw new Error(`Could not load store: ${error.message}`);
  return fromRow(data as StoreRow);
}

export type StoreSummary = Store & { businessDate: string };

export function summarizeStore(store: Store): StoreSummary {
  return { ...store, businessDate: businessDateForTimeZone(store.timeZone) };
}
