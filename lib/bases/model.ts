import { BASE_UNITS, BASE_UNIT_LABELS, ItemError, itemCost, parseItemId, standardConversion, type Item, type BaseUnit } from "@/lib/items/model";

export const OUTPUT_UNITS = ["porsi", ...BASE_UNITS] as const;
export type OutputUnit = typeof OUTPUT_UNITS[number];
export const OUTPUT_LABELS = { ...BASE_UNIT_LABELS, porsi: "Portions (porsi)" };
export type BaseIngredient = { itemId: string; quantity: number; uom: string };
export type BaseInput = { id?: string; name: string; baseUom: OutputUnit; yieldQuantity: number; ingredients: BaseIngredient[] };
export type PreparedBase = BaseInput & { id: string; recipeId: string; updatedAt: string };

export function parseBaseId(value: unknown): string {
  try { return parseItemId(value); }
  catch { throw new ItemError("Base ID must be 1–80 characters: letters, numbers, dots, hyphens, or underscores"); }
}
export function parseBaseInput(value: unknown): BaseInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError("Base details are required");
  const input = value as Record<string, unknown>;
  if (input.id !== undefined && input.id !== null && typeof input.id !== "string") throw new ItemError("Base ID must be text");
  const id = typeof input.id === "string" && input.id.trim() ? parseBaseId(input.id.trim()) : undefined;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 200) throw new ItemError("Base name is required (maximum 200 characters)");
  if (!OUTPUT_UNITS.includes(input.baseUom as OutputUnit)) throw new ItemError("Choose a base unit: portions, g, kg, ml, l, or pcs");
  function positive(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1e-9 || value > 1e12) throw new ItemError(`${label} must be positive (0.000000001 to 1 trillion)`);
    return value;
  }
  if (!Array.isArray(input.ingredients) || !input.ingredients.length || input.ingredients.length > 200) throw new ItemError("Add between 1 and 200 raw materials");
  const ingredients = input.ingredients.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError(`Ingredient ${index + 1} is invalid`);
    const row = value as Record<string, unknown>;
    const itemId = parseItemId(row.itemId);
    if (typeof row.uom !== "string" || !row.uom.trim() || row.uom.trim().length > 80) throw new ItemError(`Choose a unit for ingredient ${index + 1}`);
    let uom = row.uom.trim();
    if (BASE_UNITS.includes(uom.toLowerCase() as BaseUnit)) uom = uom.toLowerCase();
    return { itemId, quantity: positive(row.quantity, `Ingredient ${index + 1} quantity`), uom };
  });
  return { ...(id ? { id } : {}), name: input.name.trim(), baseUom: input.baseUom as OutputUnit,
    yieldQuantity: positive(input.yieldQuantity, "Batch yield"), ingredients };
}

export function ingredientUnits(item: Item): string[] {
  const units = BASE_UNITS.filter((unit) => { try { return standardConversion(unit, item.baseUom) !== null; } catch { return false; } });
  return [...new Set([...units, item.purchaseUnitName])];
}
export function ingredientQuantityBase(row: BaseIngredient, item: Item): number {
  const standard = standardConversion(row.uom, item.baseUom);
  const factor = standard ?? (row.uom.toLowerCase() === item.purchaseUnitName.toLowerCase() ? item.purchaseConversion : null);
  if (factor === null) throw new ItemError(`Choose a valid unit for ${item.name}`);
  return row.quantity * factor;
}
export function baseCost(input: Pick<BaseInput, "ingredients" | "yieldQuantity">, items: Item[]) {
  const catalog = new Map(items.map((item) => [item.id, item]));
  const lineCosts = input.ingredients.map((row) => {
    const item = catalog.get(row.itemId);
    if (!item) throw new ItemError("A raw material is unavailable. Refresh and choose it again.");
    return ingredientQuantityBase(row, item) * itemCost(item).unitCost;
  });
  const ingredientCost = lineCosts.reduce((sum, cost) => sum + cost, 0);
  const overhead = ingredientCost * 0.05;
  const totalProductionCost = ingredientCost + overhead;
  return { lineCosts, ingredientCost, overhead, totalProductionCost, unitCost: totalProductionCost / input.yieldQuantity };
}
