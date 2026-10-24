import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ItemError } from "@/lib/items/model";
import { listItems } from "@/lib/items/service";
import { listBases } from "@/lib/bases/service";
import type { Category, Product, ProductCatalog, ProductInput } from "./model";
function databaseError(error: { code: string; message: string }): never {
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(error.code)) throw new ItemError("Products database needs updating. Run npm.cmd run local:migrate for local Supabase.", 503);
  if (error.code === "23505") throw new ItemError("That product ID already exists. Choose another ID or leave it blank to generate one.", 409);
  if (error.code === "23503") throw new ItemError("An ingredient, category, or main menu product is missing, or this product is referenced by another record. Refresh and try again.", 409);
  if (error.code === "P0002") throw new ItemError("Product not found", 404);
  if (["23514", "22023"].includes(error.code)) throw new ItemError("Check the product details, positive batch yield, output unit, main menu selection and ingredient units. Every product needs at least one ingredient.");
  throw new ItemError(`Could not save or load products: ${error.message}`, 500);
}
export async function listCategories(): Promise<Category[]> {
  const categories: Category[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from("categories").select("id,name").order("name").order("id").range(offset, offset + 999);
    if (error) databaseError(error);
    categories.push(...(data || []) as Category[]);
    if (!data || data.length < 1000) return categories;
  }
}
export async function createCategory(name: string): Promise<Category> {
  const { data, error } = await getSupabaseAdmin().rpc("create_product_category", { p_name: name });
  if (error) databaseError(error);
  return data as Category;
}
type Row = { id: string; name: string; type: Product["type"]; parent_product_id: string | null; category_id: string | null; sales_price: number; base_uom: Product["baseUom"]; updated_at: string;
  recipe: { id: string; yield_qty: number; ingredients: { item_id: string | null; base_id: string | null; quantity: number; uom: string; line_number: number }[] } };
export async function listProducts(): Promise<Product[]> {
  const products: Product[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await getSupabaseAdmin().from("products")
      .select("id,name,type,parent_product_id,category_id,sales_price,base_uom,updated_at,recipe:recipes!products_recipe_fk(id,yield_qty,ingredients:recipe_ingredients(item_id,base_id,quantity,uom,line_number))")
      .order("name").order("id").range(offset, offset + 999);
    if (error) databaseError(error);
    for (const row of (data || []) as unknown as Row[]) {
      if (!row.recipe?.ingredients?.length) throw new ItemError(`Recipe is missing for ${row.name}`, 500);
      products.push({ id: row.id, name: row.name, type: row.type, parentProductId: row.parent_product_id, categoryId: row.category_id,
        salesPrice: Number(row.sales_price), baseUom: row.base_uom, yieldQuantity: Number(row.recipe.yield_qty), updatedAt: row.updated_at, recipeId: row.recipe.id,
        ingredients: [...row.recipe.ingredients].sort((a, b) => a.line_number - b.line_number).map((line) => ({ kind: line.item_id !== null ? "item" : "base", ingredientId: (line.item_id ?? line.base_id)!, quantity: Number(line.quantity), uom: line.uom })) });
    }
    if (!data || data.length < 1000) return products;
  }
}
export async function loadProductCatalog(): Promise<ProductCatalog> {
  const [products, categories, items, bases] = await Promise.all([listProducts(), listCategories(), listItems(), listBases()]);
  return { products, categories, items, bases };
}
export async function saveProduct(id: string | null, input: ProductInput): Promise<string> {
  const { data, error } = await getSupabaseAdmin().rpc("save_catalog_product", { p_id: id, p_input: input });
  if (error) databaseError(error);
  return data as string;
}
export async function deleteProduct(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("delete_catalog_product", { p_id: id });
  if (error) databaseError(error);
}
