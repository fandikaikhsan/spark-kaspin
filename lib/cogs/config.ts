import { BASE_UNITS, ItemError, parseItemId } from "@/lib/items/model";
import { OUTPUT_UNITS } from "@/lib/bases/model";
import { STOCK_FIELDS } from "@/lib/stock-opname/template";
import { parseStockUuid } from "@/lib/stock-opname/model";
import type { CountMapping, PosMapping } from "./types";

export type CogsConfigInput = { storeId: string } & (
  { kind: "pos"; mapping: PosMapping } | { kind: "count"; mapping: CountMapping } |
  { kind: "delete-pos"; itemCode: string } | { kind: "delete-count"; fieldKey: string });
function posCode(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /^unknown-\d+$/.test(value)) throw new ItemError("A stable POS item code is required");
  return value;
}
function countKey(value: unknown) {
  if (typeof value !== "string" || !STOCK_FIELDS.some((field) => field.section === "inventory" && field.key === value)) throw new ItemError("Choose one of the 22 inventory count lines");
  return value;
}
function factor(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1e-9 || value > 1e12) throw new ItemError("Unit quantity must be between 0.000000001 and 1 trillion");
  return value;
}
export function parseCogsConfig(value: unknown): CogsConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError("Configuration required");
  const raw = value as Record<string, unknown>, storeId = parseStockUuid(raw.storeId, "Store");
  if (raw.kind === "delete-pos") return { storeId, kind: raw.kind, itemCode: posCode(raw.itemCode) };
  if (raw.kind === "delete-count") return { storeId, kind: raw.kind, fieldKey: countKey(raw.fieldKey) };
  if (!raw.mapping || typeof raw.mapping !== "object" || Array.isArray(raw.mapping)) throw new ItemError("Mapping required");
  const row = raw.mapping as Record<string, unknown>;
  if (raw.kind === "pos") {
    if (!OUTPUT_UNITS.includes(row.outputUom as PosMapping["outputUom"])) throw new ItemError("Choose a valid product output unit");
    return { storeId, kind: raw.kind, mapping: { itemCode: posCode(row.itemCode), productId: parseItemId(row.productId), outputQuantity: factor(row.outputQuantity), outputUom: row.outputUom as PosMapping["outputUom"] } };
  }
  if (raw.kind === "count") {
    if (!BASE_UNITS.includes(row.baseUom as CountMapping["baseUom"])) throw new ItemError("Choose a valid item base unit");
    return { storeId, kind: raw.kind, mapping: { fieldKey: countKey(row.fieldKey), itemId: parseItemId(row.itemId), conversion: factor(row.conversion), baseUom: row.baseUom as CountMapping["baseUom"] } };
  }
  throw new ItemError("Unknown configuration action");
}
