export const ITEM_TYPES = ["raw_material", "base", "addon", "menu_item", "variant"] as const;
export type ItemType = typeof ITEM_TYPES[number];
export const TYPE_LABELS: Record<ItemType, string> = {
  raw_material: "Raw material", base: "Base", addon: "Add-on", menu_item: "Menu item", variant: "Variant",
};
export const UNITS = ["g", "kg", "ml", "l", "pcs", "porsi"] as const;
export type Unit = typeof UNITS[number];
const unitInfo: Record<Unit, { dimension: string; factor: number }> = {
  g: { dimension: "mass", factor: 1 }, kg: { dimension: "mass", factor: 1000 },
  ml: { dimension: "volume", factor: 1 }, l: { dimension: "volume", factor: 1000 },
  pcs: { dimension: "count", factor: 1 }, porsi: { dimension: "portion", factor: 1 },
};
export type Ingredient = { itemId: string; quantity: number; uom: Unit };
export type ItemInput = {
  type: ItemType; code: string; name: string; purchasePrice: number | null;
  purchaseQuantity: number | null; uom: Unit | null; supplier: string | null;
  yieldPortions: number | null; category: string | null; suggestedPrice: number | null;
  parentId: string | null; posItemCode: string | null; ingredients: Ingredient[];
};
export type EngineeringItem = ItemInput & { id: string; storeId: string; updatedAt: string };
export type Catalog = { items: EngineeringItem[]; categories: string[] };
export class EngineeringError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function isPreparation(type: ItemType) { return type === "base" || type === "addon"; }
export function isMenu(type: ItemType) { return type === "menu_item" || type === "variant"; }
export function compatibleUnits(unit: Unit): Unit[] {
  return UNITS.filter((candidate) => unitInfo[candidate].dimension === unitInfo[unit].dimension);
}
export function convertQuantity(quantity: number, from: Unit, to: Unit): number {
  if (!compatibleUnits(from).includes(to)) throw new EngineeringError(`Cannot convert ${from} to ${to}`);
  return quantity * unitInfo[from].factor / unitInfo[to].factor;
}
export function parseId(value: unknown, label = "Item ID"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new EngineeringError(`${label} is invalid`);
  }
  return value;
}
function requiredText(value: unknown, label: string, limit = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
    throw new EngineeringError(`${label} is required (maximum ${limit} characters)`);
  }
  return value.trim();
}
function optionalText(value: unknown, label: string): string | null {
  return value === null || value === undefined || value === "" ? null : requiredText(value, label);
}
function numeric(value: unknown, label: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 1e12 || (allowZero ? value < 0 : value <= 0)) {
    throw new EngineeringError(`${label} must be ${allowZero ? "zero or a positive" : "a positive"} number (maximum 1 trillion)`);
  }
  return value;
}
export function parseItemInput(value: unknown): ItemInput {
  if (!value || typeof value !== "object") throw new EngineeringError("Item details are required");
  const input = value as Record<string, unknown>;
  if (!ITEM_TYPES.includes(input.type as ItemType)) throw new EngineeringError("Choose an item type");
  const type = input.type as ItemType;
  const raw = type === "raw_material";
  const preparation = isPreparation(type);
  let ingredients: Ingredient[] = [];
  if (!raw) {
    if (!Array.isArray(input.ingredients) || input.ingredients.length < 1 || input.ingredients.length > 200) {
      throw new EngineeringError("Add between 1 and 200 ingredients");
    }
    ingredients = input.ingredients.map((value, index) => {
      if (!value || typeof value !== "object") throw new EngineeringError(`Ingredient ${index + 1} is invalid`);
      const row = value as Record<string, unknown>;
      if (!UNITS.includes(row.uom as Unit)) throw new EngineeringError(`Choose a unit for ingredient ${index + 1}`);
      return { itemId: parseId(row.itemId, "Ingredient ID"), quantity: numeric(row.quantity, "Ingredient quantity"), uom: row.uom as Unit };
    });
    if (new Set(ingredients.map((row) => row.itemId)).size !== ingredients.length) {
      throw new EngineeringError("Each ingredient may appear only once; combine its quantities");
    }
  }
  if (raw && (!UNITS.includes(input.uom as Unit) || input.uom === "porsi")) {
    throw new EngineeringError("Choose a purchase unit: g, kg, ml, l, or pcs");
  }
  return {
    type, code: raw ? requiredText(input.code, "Material ID", 80) : optionalText(input.code, "Item code") || "",
    name: requiredText(input.name, "Name"),
    purchasePrice: raw ? numeric(input.purchasePrice, "Purchase price", true) : null,
    purchaseQuantity: raw ? numeric(input.purchaseQuantity, "Purchase quantity") : null,
    uom: raw ? input.uom as Unit : null, supplier: raw ? optionalText(input.supplier, "Supplier") : null,
    yieldPortions: preparation ? numeric(input.yieldPortions, "Yield (porsi)") : null,
    category: isMenu(type) ? requiredText(input.category, "Category") : null,
    suggestedPrice: isMenu(type) ? numeric(input.suggestedPrice, "Suggested price") : null,
    parentId: type === "variant" ? parseId(input.parentId, "Main menu item") : null,
    posItemCode: isMenu(type) ? optionalText(input.posItemCode, "POS item code") : null,
    ingredients,
  };
}
export function validateReferences(input: ItemInput, items: EngineeringItem[], editingId?: string) {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (editingId && byId.get(editingId)?.type !== input.type) throw new EngineeringError("An existing item's type cannot be changed");
  if (input.type === "variant" && byId.get(input.parentId || "")?.type !== "menu_item") {
    throw new EngineeringError("Select a main menu item from this store");
  }
  for (const row of input.ingredients) {
    const item = byId.get(row.itemId);
    if (!item || row.itemId === editingId || (item.type !== "raw_material" && !(isMenu(input.type) && isPreparation(item.type)))) {
      throw new EngineeringError("Choose valid ingredients from this store; bases and add-ons can only contain raw materials");
    }
    convertQuantity(row.quantity, row.uom, item.uom || "porsi");
  }
}
export type CostSummary = {
  ingredientCost: number; overhead: number; totalProductionCost: number;
  unitCost: number; costPercentage: number | null; margin: number | null; marginPercentage: number | null;
};
export function calculateCost(item: ItemInput, items: EngineeringItem[]): CostSummary {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const visiting = new Set<ItemInput>();
  function calculate(current: ItemInput): CostSummary {
    if (visiting.has(current)) throw new EngineeringError("Recipe contains a circular reference");
    visiting.add(current);
    let ingredientCost = 0;
    if (current.type === "raw_material") {
      if (!current.purchaseQuantity || current.purchasePrice === null) throw new EngineeringError("Enter purchase price and quantity");
      ingredientCost = current.purchasePrice;
    } else {
      for (const row of current.ingredients) {
        const ingredient = byId.get(row.itemId);
        if (!ingredient) throw new EngineeringError("Select every ingredient to calculate costs");
        ingredientCost += convertQuantity(row.quantity, row.uom, ingredient.uom || "porsi") * calculate(ingredient).unitCost;
      }
    }
    const overhead = isPreparation(current.type) ? ingredientCost * 0.05 : 0;
    const totalProductionCost = ingredientCost + overhead;
    const divisor = current.type === "raw_material" ? current.purchaseQuantity : isPreparation(current.type) ? current.yieldPortions : 1;
    if (!divisor || divisor <= 0) throw new EngineeringError("Enter a positive yield to calculate cost per portion");
    const price = current.suggestedPrice;
    const margin = isMenu(current.type) && price && price > 0 ? price - totalProductionCost : null;
    visiting.delete(current);
    return { ingredientCost, overhead, totalProductionCost, unitCost: totalProductionCost / divisor,
      costPercentage: margin !== null ? totalProductionCost / price! * 100 : null,
      margin, marginPercentage: margin !== null ? margin / price! * 100 : null };
  }
  return calculate(item);
}
// Physical usage excludes the 5% cost allowance. Quantities use each material's purchase UOM.
export function theoreticalRawUsage(item: ItemInput, items: EngineeringItem[], soldQuantity = 1): Ingredient[] {
  const totals = new Map<string, Ingredient>();
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  function expand(current: ItemInput, multiplier: number) {
    for (const row of current.ingredients) {
      const ingredient = byId.get(row.itemId);
      if (!ingredient) throw new EngineeringError("Ingredient is missing");
      if (ingredient.type === "raw_material") {
        const quantity = convertQuantity(row.quantity, row.uom, ingredient.uom!) * multiplier;
        const previous = totals.get(ingredient.id);
        totals.set(ingredient.id, { itemId: ingredient.id, quantity: quantity + (previous?.quantity || 0), uom: ingredient.uom! });
      } else if (isPreparation(ingredient.type) && ingredient.yieldPortions) {
        expand(ingredient, convertQuantity(row.quantity, row.uom, "porsi") * multiplier / ingredient.yieldPortions);
      } else throw new EngineeringError("Recipe contains an invalid ingredient");
    }
  }
  expand(item, soldQuantity);
  return [...totals.values()];
}
