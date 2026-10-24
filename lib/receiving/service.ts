import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ItemError } from "@/lib/items/model";
import type { Receiving, ReceivingInput, ReceivingItem } from "./model";

function databaseError(error: { code: string; message: string }): never {
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(error.code)) throw new ItemError("Receiving belum terpasang. Jalankan npm.cmd run local:migrate untuk database lokal.", 503);
  if (error.code === "23505") throw new ItemError("Penerimaan ini sudah tersimpan dengan isian berbeda. Periksa riwayat sebelum mengisi ulang.", 409);
  if (["23503", "P0002", "40001"].includes(error.code)) throw new ItemError("Data barang atau satuannya berubah. Muat ulang halaman dan periksa kembali jumlah serta satuannya.", 409);
  if (["23514", "22023"].includes(error.code)) throw new ItemError("Periksa toko, nama penerima, barang, dan jumlah yang diterima.");
  throw new ItemError(`Receiving gagal diproses: ${error.message}`, 500);
}
export async function listReceivingItems(): Promise<ReceivingItem[]> {
  const items: ReceivingItem[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from("items").select("id,name,base_uom,updated_at,purchase_unit:units!items_purchase_unit_fk(name)")
      .order("name").order("id").range(offset, offset + 999);
    if (error) databaseError(error);
    for (const row of (data || []) as unknown as { id: string; name: string; base_uom: ReceivingItem["baseUom"]; updated_at: string; purchase_unit: { name: string } }[]) {
      if (!row.purchase_unit) throw new ItemError(`Satuan pembelian belum diatur untuk ${row.name}`, 409);
      items.push({ id: row.id, name: row.name, baseUom: row.base_uom, purchaseUnitName: row.purchase_unit.name, updatedAt: row.updated_at });
    }
    if (!data || data.length < 1000) return items;
  }
}
export async function saveReceiving(input: ReceivingInput, submittedBy: string): Promise<{ id: string; replayed: boolean }> {
  // Unit/name snapshots come from locked catalog rows inside the database, never the client.
  const { data, error } = await getSupabaseAdmin().rpc("submit_receiving", { p_id: input.id, p_store: input.storeId, p_receiver: input.receivedBy, p_submitted_by: submittedBy, p_lines: input.lines });
  if (error) databaseError(error);
  return data as { id: string; replayed: boolean };
}
export async function listReceivings(storeId?: string): Promise<Receiving[]> {
  let query = getSupabaseAdmin().from("receivings").select("id,store_id,received_by,received_at,lines:receiving_lines(line_number,item_id,item_name,quantity,received_uom)")
    .order("received_at", { ascending: false }).order("id", { ascending: false }).limit(10);
  if (storeId) query = query.eq("store_id", storeId);
  const { data, error } = await query;
  if (error) databaseError(error);
  type Row = { id: string; store_id: string; received_by: string; received_at: string; lines: { line_number: number; item_id: string; item_name: string; quantity: number | string; received_uom: string }[] };
  return ((data || []) as unknown as Row[]).map((row) => ({ id: row.id, storeId: row.store_id, receivedBy: row.received_by, receivedAt: row.received_at,
    lines: [...row.lines].sort((a, b) => a.line_number - b.line_number).map((line) => ({ itemId: line.item_id, name: line.item_name, quantity: Number(line.quantity), uom: line.received_uom })) }));
}
