import { standardConversion } from "@/lib/items/model";
import { STOCK_FIELDS } from "@/lib/stock-opname/template";
import type { CogsBase, CogsCalculation, CogsCount, CogsItem, CogsProduct, CogsReceipt, CogsRow, CogsSale, CountMapping, PosMapping } from "./types";

function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
  return value;
}
function convert(from: string, to: string): number {
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return 1;
  if (from === "porsi" || to === "porsi") throw new Error(`Cannot convert ${from} to ${to}`);
  const result = standardConversion(from, to as CogsItem["baseUom"]);
  if (result === null) throw new Error(`Cannot convert ${from} to ${to}`);
  return result;
}
function itemQuantity(quantity: number, uom: string, item: CogsItem) {
  positive(quantity, `Recipe quantity for ${item.name}`);
  // Custom units belong to the referenced item, never a universal pack size.
  const factor = uom.trim().toLowerCase() === item.purchaseUnitName.trim().toLowerCase()
    ? positive(item.purchaseConversion, `Purchase conversion for ${item.name}`) : convert(uom, item.baseUom);
  return quantity * factor;
}
const message = (error: unknown) => error instanceof Error ? error.message : "Invalid recipe";

/** Raw-material amounts per ONE output unit. No costs, prices, or 5% allowance. */
export function expandProduct(product: CogsProduct, items: CogsItem[], bases: CogsBase[]): Map<string, number> {
  const raw = new Map(items.map((item) => [item.id, item]));
  const prepared = new Map(bases.map((base) => [base.id, base]));
  const amounts = new Map<string, number>();
  const add = (id: string, qty: number) => {
    const total = (amounts.get(id) || 0) + qty;
    if (!Number.isFinite(total)) throw new Error(`Recipe quantity overflow for ${product.name}`);
    amounts.set(id, total);
  };
  positive(product.yieldQuantity, `Yield for ${product.name}`);
  if (!product.ingredients.length) throw new Error(`Recipe is missing for ${product.name}`);
  for (const ingredient of product.ingredients) {
    if (ingredient.kind === "item") {
      const item = raw.get(ingredient.ingredientId);
      if (!item) throw new Error(`Raw material ${ingredient.ingredientId} is missing`);
      add(item.id, itemQuantity(ingredient.quantity, ingredient.uom, item) / product.yieldQuantity);
    } else {
      const base = prepared.get(ingredient.ingredientId);
      if (!base) throw new Error(`Base ${ingredient.ingredientId} is missing`);
      const output = positive(ingredient.quantity, `Quantity for ${base.name}`) * convert(ingredient.uom, base.baseUom);
      positive(base.yieldQuantity, `Yield for ${base.name}`);
      if (!base.ingredients.length) throw new Error(`Recipe is missing for ${base.name}`);
      for (const row of base.ingredients) {
        const item = raw.get(row.itemId);
        if (!item) throw new Error(`Raw material ${row.itemId} is missing`);
        add(item.id, itemQuantity(row.quantity, row.uom, item) * output / base.yieldQuantity / product.yieldQuantity);
      }
    }
  }
  return amounts;
}

export type CogsInput = { items: CogsItem[]; bases: CogsBase[]; products: CogsProduct[];
  posMappings: PosMapping[]; countMappings: CountMapping[]; opening: CogsCount | null; closing: CogsCount | null;
  sales: CogsSale[]; receipts: CogsReceipt[]; salesIssues?: string[] };

export function calculateConsumption(input: CogsInput): CogsCalculation {
  const issues = [...(input.salesIssues || [])];
  const intervalValid = Boolean(input.opening?.countedAt && input.closing?.countedAt &&
    Date.parse(input.opening.countedAt) < Date.parse(input.closing.countedAt));
  if (!intervalValid) issues.push("Two stock counts with recorded count times are required for a completed interval.");
  const amounts = new Map<string, number>();
  const mappings = new Map(input.posMappings.map((mapping) => [mapping.itemCode, mapping]));
  const products = new Map(input.products.map((product) => [product.id, product]));
  const grouped = new Map<string, { names: Set<string>; quantity: number; invalid: boolean }>();
  for (const sale of input.sales) {
    const group = grouped.get(sale.itemCode) || { names: new Set<string>(), quantity: 0, invalid: false };
    group.names.add(sale.itemName);
    if (![sale.quantity, sale.returnedQuantity].every(Number.isFinite) || sale.quantity < 0 || sale.returnedQuantity < 0 || sale.returnedQuantity > sale.quantity) group.invalid = true;
    else group.quantity += sale.quantity - sale.returnedQuantity;
    grouped.set(sale.itemCode, group);
  }
  const sales = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([itemCode, group]) => {
    const mapping = mappings.get(itemCode);
    let issue: string | null = null;
    // Fully returned lines have no theoretical usage. A missing mapping matters only for positive net sales.
    if (group.invalid) issue = "Invalid sale or return quantity";
    else if (group.quantity > 0) {
      if (/^unknown-\d+$/.test(itemCode)) issue = "POS item has no stable item code; fix the source before linking";
      else if (!mapping) issue = "Link this POS code to a catalogue product";
      else {
        const product = products.get(mapping.productId);
        if (!product) issue = "Linked product no longer exists";
        else try {
          const perUnit = expandProduct(product, input.items, input.bases);
          const units = positive(mapping.outputQuantity, "Output per POS unit") * convert(mapping.outputUom, product.baseUom) * group.quantity;
          for (const [id, qty] of perUnit) {
            const total = (amounts.get(id) || 0) + qty * units;
            if (!Number.isFinite(total)) throw new Error("Theoretical quantity exceeds supported range");
            amounts.set(id, total);
          }
        } catch (error) { issue = message(error); }
      }
    }
    if (issue) issues.push(`${itemCode}: ${issue}`);
    return { itemCode, names: [...group.names].sort(), quantity: group.quantity, productId: mapping?.productId || null, issue };
  });
  const theoreticalReady = intervalValid && issues.length === 0;
  const countMappings = new Map(input.countMappings.map((mapping) => [mapping.fieldKey, mapping]));
  const items = new Map(input.items.map((item) => [item.id, item]));
  const duplicates = new Set(input.countMappings.filter((mapping, i, all) => all.some((other, j) => i !== j && mapping.itemId === other.itemId)).map((mapping) => mapping.itemId));
  const rows: CogsRow[] = STOCK_FIELDS.filter((field) => field.section === "inventory").map((field) => {
    const mapping = countMappings.get(field.key), item = mapping ? items.get(mapping.itemId) : undefined;
    const row: CogsRow = { key: field.key, name: field.name, itemId: item?.id || null, uom: item?.baseUom || null,
      opening: null, received: null, closing: null, actual: null, theoretical: item && theoreticalReady ? amounts.get(item.id) || 0 : null, delta: null, issues: [] };
    if (!mapping || !item) row.issues.push("Define the counted item and count-unit size in setup");
    else if (duplicates.has(item.id)) row.issues.push("The same raw material is linked to more than one count line");
    else if (intervalValid) {
      try {
        const factor = positive(mapping.conversion, "Count-unit conversion") * convert(mapping.baseUom, item.baseUom);
        const countQty = (count: CogsCount) => {
          const line = count.lines.find((line) => line.key === field.key);
          if (!line || !Number.isFinite(line.quantity) || line.quantity < 0) throw new Error("Opening or closing count is missing or invalid");
          if (line.itemId && line.itemId !== item.id) throw new Error("Count refers to a different raw material; review its item link");
          if (line.uom.toLowerCase() !== field.uom?.toLowerCase()) throw new Error("Count unit differs from the configured form unit");
          return line.quantity * factor;
        };
        row.opening = countQty(input.opening!); row.closing = countQty(input.closing!);
        row.received = input.receipts.filter((receipt) => receipt.itemId === item.id).reduce((total, receipt) => {
          if (!Number.isFinite(receipt.quantityBase) || receipt.quantityBase < 0) throw new Error("Invalid receiving quantity");
          return total + receipt.quantityBase * convert(receipt.baseUom, item.baseUom);
        }, 0);
        row.actual = row.opening + row.received - row.closing;
        if (![row.actual, row.opening, row.received, row.closing].every(Number.isFinite)) throw new Error("Quantity exceeds supported range");
        if (Math.abs(row.actual) < 1e-9) row.actual = 0;
        if (row.actual < 0) row.issues.push("Stock increased beyond recorded receiving; check counts and missing deliveries");
        else if (row.theoretical !== null) {
          const delta=row.actual-row.theoretical;
          row.delta=Math.abs(delta)<1e-9?0:delta;
        }
      } catch (error) { row.actual = null; row.issues.push(message(error)); }
    }
    return row;
  });
  return { rows, sales, issues, complete: theoreticalReady && rows.every((row) => row.delta !== null && !row.issues.length) };
}
