import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ItemError } from "@/lib/items/model";
import { STOCK_FIELDS } from "./template";
import { stockLines, type StockOpname, type StockOpnameInput } from "./model";
function databaseError(error: { code: string; message: string }): never {
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(error.code)) throw new ItemError("Stock Opname belum terpasang. Jalankan npm.cmd run local:migrate untuk database lokal.", 503);
  if (error.code === "23505") throw new ItemError("Pengiriman ini sudah tersimpan dengan jawaban berbeda. Periksa riwayat sebelum mengisi ulang.", 409);
  if (error.code === "23503") throw new ItemError("Toko atau barang berubah. Muat ulang halaman lalu coba lagi.", 409);
  if (["23514", "22023"].includes(error.code)) throw new ItemError("Periksa toko, nama, tanggal, dan seluruh 40 jawaban.");
  throw new ItemError(`Stock opname gagal diproses: ${error.message}`, 500);
}
type Reference = { id: string; name: string };
async function references(table: "items" | "bases"): Promise<Reference[]> {
  const rows: Reference[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from(table).select("id,name").order("id").range(offset, offset + 999);
    if (error) databaseError(error);
    rows.push(...(data || []) as Reference[]);
    if (!data || data.length < 1000) return rows;
  }
}
export async function saveStockOpname(input: StockOpnameInput, submittedBy: string): Promise<{ id: string; replayed: boolean }> {
  // Only IDs/names are needed for optional links. Prices are never part of this form.
  const [items, bases] = await Promise.all([references("items"), references("bases")]);
  const normalize = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
  const lines = stockLines(input).map((line, index) => {
    const aliases = new Set(STOCK_FIELDS[index].aliases.map(normalize));
    const matches = (line.section === "prep" ? bases : items).filter((row) => aliases.has(normalize(row.name)));
    const reference = matches.length === 1 ? matches[0].id : null;
    return { field_key: line.key, section: line.section, name: line.name, uom: line.uom, note: line.note, quantity: line.quantity, needs_restock: line.needsRestock,
      item_id: line.section === "prep" ? null : reference, base_id: line.section === "prep" ? reference : null };
  });
  const { data, error } = await getSupabaseAdmin().rpc(input.countedAt ? "submit_stock_opname_at" : "submit_stock_opname", { p_id: input.id, p_store: input.storeId, p_date: input.countDate, p_counter: input.countedBy, p_submitted_by: submittedBy, p_lines: lines, ...(input.countedAt ? { p_counted_at: input.countedAt } : {}) });
  if (error) databaseError(error);
  return data as { id: string; replayed: boolean };
}
type Row = { id: string; store_id: string; count_date: string; counted_at: string | null; counted_by: string; submitted_at: string;
  lines: { field_key: string; section: StockOpname["lines"][number]["section"]; name: string; uom: string | null; note: string; quantity: number | null; needs_restock: boolean | null }[] };
export async function listStockOpnames(storeId?: string): Promise<StockOpname[]> {
  let query = getSupabaseAdmin().from("stock_opnames").select("id,store_id,count_date,counted_at,counted_by,submitted_at,lines:stock_opname_lines(field_key,section,name,uom,note,quantity,needs_restock)")
    .order("submitted_at", { ascending: false }).order("id", { ascending: false }).limit(10);
  if (storeId) query = query.eq("store_id", storeId);
  const { data, error } = await query;
  if (error) databaseError(error);
  const order = new Map(STOCK_FIELDS.map((field, index) => [field.key, index]));
  return ((data || []) as unknown as Row[]).map((row) => ({ id: row.id, storeId: row.store_id, countDate: row.count_date, countedAt: row.counted_at, countedBy: row.counted_by, submittedAt: row.submitted_at,
    lines: [...row.lines].sort((a, b) => (order.get(a.field_key) ?? 999) - (order.get(b.field_key) ?? 999)).map((line) => ({ key: line.field_key, section: line.section, name: line.name, uom: line.uom, note: line.note,
      quantity: line.quantity === null ? null : Number(line.quantity), needsRestock: line.needs_restock })) }));
}
