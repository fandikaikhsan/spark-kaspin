import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ItemError, type Item, type ItemInput } from "./model";

type ItemRow = {
  id: string; name: string; supplier: string | null; base_uom: Item["baseUom"]; purchase_price: number;
  purchase_qty: number; purchase_unit_id: string; updated_at: string;
  purchase_unit: { id: string; name: string; conversion: number };
};

function databaseError(error: { code: string; message: string }): never {
  if (["PGRST205", "PGRST202", "42P01", "42883", "42703"].includes(error.code)) {
    throw new ItemError("Items database needs updating. Run npm.cmd run local:migrate for local Supabase, or apply the Items migrations in the Supabase SQL Editor.", 503);
  }
  if (error.code === "23503") throw new ItemError("This item or unit is used by another record and cannot be deleted or changed", 409);
  if (error.code === "23505") throw new ItemError(error.message.includes("items_pkey") ? "That item ID already exists. Choose a different ID or leave it blank to generate one." : "That purchase unit already exists for this item", 409);
  if (error.code === "P0002") throw new ItemError("Item not found", 404);
  if (error.code === "23514" || error.code === "22023") throw new ItemError("Check the item details and purchase-unit conversion");
  throw new ItemError(`Could not save or load items: ${error.message}`, 500);
}

export async function listItems(): Promise<Item[]> {
  const items: Item[] = [];
  // Do not silently truncate the catalog at Supabase's default 1,000-row limit.
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from("items")
      .select("id,name,supplier,base_uom,purchase_price,purchase_qty,purchase_unit_id,updated_at,purchase_unit:units!items_purchase_unit_fk(id,name,conversion)")
      .order("name").order("id").range(offset, offset + 999);
    if (error) databaseError(error);
    for (const row of (data || []) as unknown as ItemRow[]) {
      if (!row.purchase_unit) throw new ItemError(`Purchase unit is missing for ${row.name}`, 500);
      items.push({
        id: row.id, name: row.name, supplier: row.supplier || "", baseUom: row.base_uom,
        purchasePrice: Number(row.purchase_price), purchaseQuantity: Number(row.purchase_qty),
        purchaseUnitId: row.purchase_unit_id, purchaseUnitName: row.purchase_unit.name,
        purchaseConversion: Number(row.purchase_unit.conversion), updatedAt: row.updated_at,
      });
    }
    if (!data || data.length < 1000) return items;
  }
}

export async function saveItem(id: string | null, input: ItemInput): Promise<string> {
  const { data, error } = await getSupabaseAdmin().rpc("save_inventory_item", { p_id: id, p_input: input });
  if (error) databaseError(error);
  return data as string;
}

export async function deleteItem(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("delete_inventory_item", { p_id: id });
  if (error) databaseError(error);
}
