import { BASE_UNITS, ItemError, itemCost, parseItemId, standardConversion, type Item } from "@/lib/items/model";
import { OUTPUT_UNITS, baseCost, ingredientQuantityBase, ingredientUnits, type OutputUnit, type PreparedBase } from "@/lib/bases/model";
export const PRODUCT_TYPES = ["menu", "variant", "addon"] as const;
export type ProductType = typeof PRODUCT_TYPES[number];
export const PRODUCT_LABELS: Record<ProductType, string> = { menu: "Menu", variant: "Variant", addon: "Add-on" };
export type Category = { id: string; name: string };
export type ProductIngredient = { kind: "item" | "base"; ingredientId: string; quantity: number; uom: string };
export type ProductInput = { id?: string; name: string; type: ProductType; parentProductId: string | null; categoryId: string | null; salesPrice: number; baseUom: OutputUnit; yieldQuantity: number; ingredients: ProductIngredient[] };
export type Product = ProductInput & { id: string; recipeId: string; updatedAt: string };
export type ProductCatalog = { products: Product[]; categories: Category[]; items: Item[]; bases: PreparedBase[] };
export function parseProductId(value: unknown): string {
  try { return parseItemId(value); } catch { throw new ItemError("Product ID must be 1–80 characters: letters, numbers, dots, hyphens, or underscores"); }
}
export function parseCategoryName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new ItemError("Category name is required (maximum 200 characters)");
  return value.trim();
}
export function parseProductInput(value: unknown): ProductInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError("Product details are required");
  const input = value as Record<string, unknown>;
  if (input.id !== undefined && input.id !== null && typeof input.id !== "string") throw new ItemError("Product ID must be text");
  const id = typeof input.id === "string" && input.id.trim() ? parseProductId(input.id.trim()) : undefined;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) throw new ItemError("Product name is required (maximum 200 characters)");
  if (!PRODUCT_TYPES.includes(input.type as ProductType)) throw new ItemError("Choose Menu, Variant, or Add-on");
  const type = input.type as ProductType;
  let parentProductId: string | null = null;
  if (type === "variant") {
    parentProductId = parseProductId(input.parentProductId);
    if (parentProductId === id) throw new ItemError("A variant cannot be its own main menu product");
  } else if (input.parentProductId !== undefined && input.parentProductId !== null && input.parentProductId !== "") throw new ItemError("Only variants can have a main menu product");
  let categoryId: string | null = null;
  if (input.categoryId !== undefined && input.categoryId !== null && input.categoryId !== "") {
    if (typeof input.categoryId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.categoryId)) throw new ItemError("Choose an existing category");
    categoryId = input.categoryId;
  }
  if (typeof input.salesPrice !== "number" || !Number.isFinite(input.salesPrice) || input.salesPrice < 0 || input.salesPrice > 1e12) throw new ItemError("Selling price must be zero or positive (maximum 1 trillion)");
  const baseUom = input.baseUom;
  const yieldQuantity = input.yieldQuantity;
  if (!OUTPUT_UNITS.includes(baseUom as OutputUnit)) throw new ItemError("Choose an output unit: portions, g, kg, ml, l, or pcs");
  if (typeof yieldQuantity !== "number" || !Number.isFinite(yieldQuantity) || yieldQuantity < 1e-9 || yieldQuantity > 1e12) throw new ItemError("Batch yield must be positive (0.000000001 to 1 trillion)");
  if (!Array.isArray(input.ingredients) || !input.ingredients.length || input.ingredients.length > 200) throw new ItemError("Add between 1 and 200 ingredients");
  const ingredients = input.ingredients.map((value, index): ProductIngredient => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError(`Ingredient ${index + 1} is invalid`);
    const row = value as Record<string, unknown>;
    if (row.kind !== "item" && row.kind !== "base") throw new ItemError("Product ingredients must be raw materials or bases");
    const ingredientId = parseItemId(row.ingredientId);
    if (typeof row.quantity !== "number" || !Number.isFinite(row.quantity) || row.quantity < 1e-9 || row.quantity > 1e12) throw new ItemError(`Ingredient ${index + 1} quantity must be positive (0.000000001 to 1 trillion)`);
    if (typeof row.uom !== "string" || !row.uom.trim() || row.uom.trim().length > 80) throw new ItemError(`Choose a unit for ingredient ${index + 1}`);
    const trimmedUnit = row.uom.trim();
    const uom = [...BASE_UNITS, "porsi"].includes(trimmedUnit.toLowerCase()) ? trimmedUnit.toLowerCase() : trimmedUnit;
    return { kind: row.kind, ingredientId, quantity: row.quantity, uom };
  });
  return { ...(id ? { id } : {}), name: input.name.trim(), type, parentProductId, categoryId, salesPrice: input.salesPrice, baseUom: baseUom as OutputUnit, yieldQuantity, ingredients };
}
export function preparedBaseUnits(base: PreparedBase): string[] {
  if (base.baseUom === "porsi") return ["porsi"];
  return BASE_UNITS.filter((unit) => { try { return standardConversion(unit, base.baseUom as Item["baseUom"]) !== null; } catch { return false; } });
}
export function productIngredientUnits(row: Pick<ProductIngredient, "kind" | "ingredientId">, items: Item[], bases: PreparedBase[]): string[] {
  if (row.kind === "item") { const item = items.find((item) => item.id === row.ingredientId); return item ? ingredientUnits(item) : []; }
  const base = bases.find((base) => base.id === row.ingredientId); return base ? preparedBaseUnits(base) : [];
}
export function productCost(input: Pick<ProductInput, "ingredients" | "salesPrice"> & Partial<Pick<ProductInput, "yieldQuantity">>, items: Item[], bases: PreparedBase[]) {
  const yieldQuantity = input.yieldQuantity ?? 1;
  if (!Number.isFinite(yieldQuantity) || yieldQuantity < 1e-9 || yieldQuantity > 1e12) throw new ItemError("Batch yield must be positive");
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const baseMap = new Map(bases.map((base) => [base.id, base]));
  const lineCosts = input.ingredients.map((row) => {
    if (row.kind === "item") {
      const item = itemMap.get(row.ingredientId);
      if (!item) throw new ItemError("A raw material is unavailable. Refresh and choose it again.");
      return ingredientQuantityBase({ itemId: item.id, quantity: row.quantity, uom: row.uom }, item) * itemCost(item).unitCost;
    }
    const base = baseMap.get(row.ingredientId);
    if (!base) throw new ItemError("A base is unavailable. Refresh and choose it again.");
    let factor: number | null;
    if (base.baseUom === "porsi") factor = row.uom.toLowerCase() === "porsi" ? 1 : null;
    else factor = standardConversion(row.uom, base.baseUom);
    if (factor === null) throw new ItemError(`Choose a compatible unit for ${base.name}. Portions need a measured conversion before using weight or volume.`);
    return row.quantity * factor * baseCost(base, items).unitCost;
  });
  const totalProductionCost = lineCosts.reduce((sum, cost) => sum + cost, 0);
  const unitCost = totalProductionCost / yieldQuantity;
  const margin = input.salesPrice - unitCost;
  return { lineCosts, totalProductionCost, unitCost, margin, costPercentage: input.salesPrice > 0 ? unitCost / input.salesPrice * 100 : null,
    marginPercentage: input.salesPrice > 0 ? margin / input.salesPrice * 100 : null };
}
