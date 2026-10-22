export const BASE_UNITS = ["g", "kg", "ml", "l", "pcs"] as const;
export type BaseUnit = typeof BASE_UNITS[number];

export const BASE_UNIT_LABELS: Record<BaseUnit, string> = {
  g: "Grams (g)", kg: "Kilograms (kg)", ml: "Millilitres (ml)", l: "Litres (l)", pcs: "Pieces (pcs)",
};

export type ItemInput = {
  id?: string;
  supplier?: string;
  name: string;
  baseUom: BaseUnit;
  purchasePrice: number;
  purchaseQuantity: number;
  purchaseUnitName: string;
  purchaseConversion: number;
};

export type Item = ItemInput & { id: string; purchaseUnitId: string; updatedAt: string };

export class ItemError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const standardUnits: Record<BaseUnit, { dimension: string; factor: number }> = {
  g: { dimension: "mass", factor: 1 }, kg: { dimension: "mass", factor: 1000 },
  ml: { dimension: "volume", factor: 1 }, l: { dimension: "volume", factor: 1000 },
  pcs: { dimension: "count", factor: 1 },
};

// null means a custom unit (bag/carton/etc.) whose size must be supplied explicitly.
export function standardConversion(name: string, base: BaseUnit): number | null {
  const unit = name.trim().toLowerCase();
  if (!BASE_UNITS.includes(unit as BaseUnit)) return null;
  const from = standardUnits[unit as BaseUnit];
  const to = standardUnits[base];
  if (from.dimension !== to.dimension) throw new ItemError(`${unit} cannot be converted to ${base}. Choose a compatible purchase unit.`);
  return from.factor / to.factor;
}

export function parseItemId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new ItemError("Item ID must be 1–80 characters: letters, numbers, dots, hyphens, or underscores");
  }
  return value;
}

export function parseItemInput(value: unknown): ItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError("Item details are required");
  const input = value as Record<string, unknown>;
  if (input.id !== undefined && input.id !== null && typeof input.id !== "string") throw new ItemError("Item ID must be text");
  const id = typeof input.id === "string" && input.id.trim() ? parseItemId(input.id.trim()) : undefined;
  if (input.supplier !== undefined && input.supplier !== null && typeof input.supplier !== "string") throw new ItemError("Supplier must be text");
  const supplier = typeof input.supplier === "string" ? input.supplier.trim() : "";
  if (supplier.length > 1000) throw new ItemError("Supplier must be no more than 1,000 characters");
  function label(key: string, description: string, max: number) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
      throw new ItemError(`${description} is required (maximum ${max} characters)`);
    }
    return value.trim();
  }
  function number(key: string, description: string, zeroAllowed = false) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value > 1e12 || value < (zeroAllowed ? 0 : 1e-9)) {
      throw new ItemError(`${description} must be ${zeroAllowed ? "zero or positive" : "at least 0.000000001"} and no more than 1 trillion`);
    }
    return value;
  }
  if (!BASE_UNITS.includes(input.baseUom as BaseUnit)) throw new ItemError("Choose a base unit: g, kg, ml, l, or pcs");
  const baseUom = input.baseUom as BaseUnit;
  let purchaseUnitName = label("purchaseUnitName", "Purchase unit", 80);
  const standard = standardConversion(purchaseUnitName, baseUom);
  const purchaseConversion = number("purchaseConversion", "Unit conversion");
  if (standard !== null) {
    purchaseUnitName = purchaseUnitName.toLowerCase();
    if (purchaseConversion !== standard) {
      throw new ItemError(`1 ${purchaseUnitName} must equal ${standard} ${baseUom}`);
    }
  }
  return {
    ...(id ? { id } : {}), supplier,
    name: label("name", "Item name", 200), baseUom,
    purchasePrice: number("purchasePrice", "Reference purchase price", true),
    purchaseQuantity: number("purchaseQuantity", "Purchase quantity"),
    purchaseUnitName, purchaseConversion,
  };
}

export function itemCost(input: Pick<ItemInput, "purchaseQuantity" | "purchaseConversion" | "purchasePrice">) {
  const quantityBase = input.purchaseQuantity * input.purchaseConversion;
  return { quantityBase, unitCost: input.purchasePrice / quantityBase };
}
