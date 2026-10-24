import type { Item } from "@/lib/items/model";
import type { PreparedBase } from "@/lib/bases/model";
import type { Product } from "@/lib/products/model";

// Only operational quantities cross this boundary. Prices are deliberately absent.
export type CogsItem = Pick<Item, "id" | "name" | "baseUom" | "purchaseUnitName" | "purchaseConversion">;
export type CogsBase = Pick<PreparedBase, "id" | "name" | "baseUom" | "yieldQuantity" | "ingredients">;
export type CogsProduct = Pick<Product, "id" | "name" | "type" | "baseUom" | "yieldQuantity" | "ingredients">;
export type PosMapping = { itemCode: string; productId: string; outputQuantity: number; outputUom: Product["baseUom"] };
export type CountMapping = { fieldKey: string; itemId: string; conversion: number; baseUom: Item["baseUom"] };
export type CogsCount = { id: string; date: string; countedAt: string | null; countedBy: string;
  lines: { key: string; itemId: string | null; quantity: number; uom: string }[] };
export type CogsSale = { itemCode: string; itemName: string; quantity: number; returnedQuantity: number };
export type CogsReceipt = { itemId: string; quantityBase: number; baseUom: Item["baseUom"] };
export type CogsRow = { key: string; name: string; itemId: string | null; uom: string | null;
  opening: number | null; received: number | null; closing: number | null;
  actual: number | null; theoretical: number | null; delta: number | null; issues: string[] };
export type CogsCalculation = { rows: CogsRow[]; issues: string[]; complete: boolean;
  sales: { itemCode: string; names: string[]; quantity: number; productId: string | null; issue: string | null }[] };
export type CogsReport = CogsCalculation & { storeId: string; startDate: string; endDate: string;
  opening: Omit<CogsCount, "lines"> | null; closing: Omit<CogsCount, "lines"> | null;
  counts: Omit<CogsCount, "lines">[]; lastSyncedAt: string | null;
  setup: { items: CogsItem[]; products: Pick<CogsProduct, "id" | "name" | "type" | "baseUom">[];
    posMappings: PosMapping[]; countMappings: CountMapping[] } };
