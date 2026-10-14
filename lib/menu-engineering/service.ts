import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { EngineeringError, parseId, type Catalog, type EngineeringItem, type Ingredient, type ItemInput } from "./model";

// Supabase defaults to 1,000 rows. Read every page so ingredient lookups remain complete.
async function allRows<T>(table: string, storeId: string, order: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from(table).select("*")
      .eq("store_id", storeId).order(order).range(offset, offset + 999);
    if (error) {
      throw new EngineeringError(
        error.code === "PGRST205" || error.code === "42P01"
          ? "Menu engineering is not installed yet. Run supabase/migrations/20261013_menu_engineering.sql in the Supabase SQL Editor."
          : `Could not load menu engineering: ${error.message}`, 500,
      );
    }
    rows.push(...(data as T[]));
    if (data.length < 1000) return rows;
  }
}
type ItemRow = {
  id: string; store_id: string; type: EngineeringItem["type"]; code: string; name: string;
  purchase_price: number | null; purchase_quantity: number | null; uom: EngineeringItem["uom"];
  supplier: string | null; yield_portions: number | null; category: string | null;
  suggested_price: number | null; parent_id: string | null; pos_item_code: string | null; updated_at: string;
};
type IngredientRow = { recipe_id: string; ingredient_id: string; quantity: number; uom: Ingredient["uom"]; position: number };
const numberOrNull = (value: number | null) => value === null ? null : Number(value);
export async function loadCatalog(storeId: string): Promise<Catalog> {
  parseId(storeId, "Store ID");
  const [rows, ingredients, categories] = await Promise.all([
    allRows<ItemRow>("engineering_items", storeId, "id"),
    allRows<IngredientRow>("engineering_ingredients", storeId, "recipe_id,position"),
    allRows<{ category: string }>("pos_menu_categories", storeId, "category"),
  ]);
  const grouped = new Map<string, Ingredient[]>();
  for (const row of ingredients) {
    const list = grouped.get(row.recipe_id) || [];
    list.push({ itemId: row.ingredient_id, quantity: Number(row.quantity), uom: row.uom });
    grouped.set(row.recipe_id, list);
  }
  const items: EngineeringItem[] = rows.map((row) => ({
    id: row.id, storeId: row.store_id, type: row.type, code: row.code, name: row.name,
    purchasePrice: numberOrNull(row.purchase_price), purchaseQuantity: numberOrNull(row.purchase_quantity),
    uom: row.uom, supplier: row.supplier, yieldPortions: numberOrNull(row.yield_portions), category: row.category,
    suggestedPrice: numberOrNull(row.suggested_price), parentId: row.parent_id, posItemCode: row.pos_item_code,
    updatedAt: row.updated_at, ingredients: grouped.get(row.id) || [],
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { items, categories: [...new Set([...categories.map((row) => row.category), ...items.flatMap((item) => item.category ? [item.category] : [])])].sort() };
}
function mutationError(error: { code: string; message: string }): never {
  if (error.code === "23505") throw new EngineeringError("That material/item ID or POS item code is already used in this store", 409);
  if (error.code === "23503") throw new EngineeringError("This item is used by another recipe or variant, or a selected ingredient no longer exists", 409);
  if (error.message === "Item not found" || error.message === "Store not found") throw new EngineeringError(error.message, 404);
  throw new EngineeringError(error.message, error.code === "P0001" || error.code.startsWith("23") ? 400 : 500);
}
export async function saveItem(storeId: string, id: string | null, input: ItemInput): Promise<string> {
  const { data, error } = await getSupabaseAdmin().rpc("save_engineering_item", { p_store_id: storeId, p_id: id, p_input: input });
  if (error) mutationError(error);
  return data as string;
}
export async function deleteItem(storeId: string, id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("delete_engineering_item", { p_store_id: storeId, p_id: id });
  if (error) mutationError(error);
}
