import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ItemError } from "@/lib/items/model";
import type { BaseInput, PreparedBase } from "./model";

function databaseError(error: { code: string; message: string }): never {
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(error.code)) throw new ItemError("Bases database needs updating. Run npm.cmd run local:migrate for local Supabase.", 503);
  if (error.code === "23505") throw new ItemError("That base ID already exists. Choose another ID or leave it blank to generate one.", 409);
  if (error.code === "23503") throw new ItemError("A raw material is missing, or this base is referenced by another record. Refresh and try again.", 409);
  if (error.code === "P0002") throw new ItemError("Base not found", 404);
  if (["23514", "22023"].includes(error.code)) throw new ItemError("Check the base details, positive yield, and ingredient units. At least one raw material is required.");
  throw new ItemError(`Could not save or load bases: ${error.message}`, 500);
}
type Row = { id: string; name: string; base_uom: PreparedBase["baseUom"]; updated_at: string;
  recipe: { id: string; yield_qty: number; ingredients: { item_id: string; quantity: number; uom: string; line_number: number }[] } };
export async function listBases(): Promise<PreparedBase[]> {
  const bases: PreparedBase[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from("bases")
      .select("id,name,base_uom,updated_at,recipe:recipes!bases_recipe_fk(id,yield_qty,ingredients:recipe_ingredients(item_id,quantity,uom,line_number))")
      .order("name").order("id").range(offset, offset + 999);
    if (error) databaseError(error);
    for (const row of (data || []) as unknown as Row[]) {
      if (!row.recipe || !row.recipe.ingredients?.length) throw new ItemError(`Recipe is missing for ${row.name}`, 500);
      bases.push({ id: row.id, name: row.name, baseUom: row.base_uom, updatedAt: row.updated_at,
        recipeId: row.recipe.id, yieldQuantity: Number(row.recipe.yield_qty),
        ingredients: [...row.recipe.ingredients].sort((a, b) => a.line_number - b.line_number)
          .map((line) => ({ itemId: line.item_id, quantity: Number(line.quantity), uom: line.uom })) });
    }
    if (!data || data.length < 1000) return bases;
  }
}
export async function saveBase(id: string | null, input: BaseInput): Promise<string> {
  const { data, error } = await getSupabaseAdmin().rpc("save_prepared_base", { p_id: id, p_input: input });
  if (error) databaseError(error);
  return data as string;
}
export async function deleteBase(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("delete_prepared_base", { p_id: id });
  if (error) databaseError(error);
}
