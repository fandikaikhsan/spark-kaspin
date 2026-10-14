import { describe, expect, it } from "vitest";
import {
  calculateCost, convertQuantity, parseItemInput, theoreticalRawUsage, validateReferences,
  type EngineeringItem, type ItemInput,
} from "@/lib/menu-engineering/model";

const ids = { milk: "00000000-0000-4000-8000-000000000001", sugar: "00000000-0000-4000-8000-000000000002", base: "00000000-0000-4000-8000-000000000003", menu: "00000000-0000-4000-8000-000000000004" };
const empty: ItemInput = {
  type: "raw_material", code: "RM-001", name: "Milk", purchasePrice: 20000, purchaseQuantity: 1,
  uom: "l", supplier: null, yieldPortions: null, category: null, suggestedPrice: null,
  parentId: null, posItemCode: null, ingredients: [],
};
function record(id: string, input: ItemInput): EngineeringItem { return { ...input, id, storeId: "store", updatedAt: "2026-10-13" }; }
const milk = record(ids.milk, empty);
const sugar = record(ids.sugar, { ...empty, code: "RM-002", name: "Sugar", uom: "kg", purchasePrice: 16000 });
const base = record(ids.base, { ...empty, type: "base", code: "BASE-1", name: "Sweet milk", purchasePrice: null, purchaseQuantity: null, uom: null,
  yieldPortions: 10, ingredients: [{ itemId: ids.milk, quantity: 500, uom: "ml" }, { itemId: ids.sugar, quantity: 100, uom: "g" }] });
const menu = record(ids.menu, { ...empty, type: "menu_item", code: "MENU-1", name: "Latte", purchasePrice: null, purchaseQuantity: null, uom: null,
  suggestedPrice: 20000, category: "Original POS Category", ingredients: [{ itemId: ids.base, quantity: 2, uom: "porsi" }, { itemId: ids.milk, quantity: 100, uom: "ml" }] });
const catalog = [milk, sugar, base, menu];

describe("menu engineering costs and physical usage", () => {
  it("converts compatible units and rejects dimensional mismatches", () => {
    expect(convertQuantity(150, "g", "kg")).toBe(0.15);
    expect(convertQuantity(2, "l", "ml")).toBe(2000);
    expect(() => convertQuantity(1, "pcs", "g")).toThrow("Cannot convert");
    expect(() => convertQuantity(1, "ml", "porsi")).toThrow("Cannot convert");
  });
  it("normalizes purchase cost by quantity instead of treating package price as unit price", () => {
    expect(calculateCost({ ...milk, purchaseQuantity: 2 }, catalog).unitCost).toBe(10000);
    expect(calculateCost({ ...milk, purchasePrice: 0 }, catalog).unitCost).toBe(0);
  });
  it("adds 5% only to prepared batch costs and divides by yield", () => {
    expect(calculateCost(base, catalog)).toMatchObject({ ingredientCost: 11600, overhead: 580, totalProductionCost: 12180, unitCost: 1218 });
    expect(calculateCost({ ...base, type: "addon" }, catalog).unitCost).toBe(1218);
  });
  it("includes bases and direct materials without applying a second allowance", () => {
    expect(calculateCost(menu, catalog)).toMatchObject({ totalProductionCost: 4436, costPercentage: 22.18, margin: 15564, marginPercentage: 77.82 });
    expect(calculateCost({ ...menu, suggestedPrice: 4000 }, catalog).margin).toBe(-436);
  });
  it("recalculates dependent costs when material prices and yields change", () => {
    const repriced = catalog.map((item) => item.id === ids.milk ? { ...item, purchasePrice: 40000 } : item);
    expect(calculateCost(menu, repriced).totalProductionCost).toBe(8536);
    expect(calculateCost(menu, catalog.map((item) => item.id === ids.base ? { ...item, yieldPortions: 20 } : item)).totalProductionCost).toBe(3218);
  });
  it("expands and aggregates raw usage while excluding the monetary allowance", () => {
    const usage = theoreticalRawUsage(menu, catalog, 3);
    expect(usage.find((row) => row.itemId === ids.milk)?.quantity).toBeCloseTo(0.6);
    expect(usage.find((row) => row.itemId === ids.sugar)).toEqual({ itemId: ids.sugar, quantity: 0.06, uom: "kg" });
  });
  it("rejects incomplete references and zero yields instead of returning invalid costs", () => {
    expect(() => calculateCost({ ...base, yieldPortions: 0 }, catalog)).toThrow("positive yield");
    expect(() => calculateCost(menu, [])).toThrow("Select every ingredient");
  });
});

describe("menu engineering validation", () => {
  it("requires all raw-material fields and leaves supplier optional", () => {
    expect(parseItemInput(empty).supplier).toBeNull();
    for (const field of ["code", "name", "purchasePrice", "purchaseQuantity", "uom"]) {
      expect(() => parseItemInput({ ...empty, [field]: null })).toThrow();
    }
    expect(() => parseItemInput({ ...empty, purchaseQuantity: 0 })).toThrow();
    expect(() => parseItemInput({ ...empty, purchasePrice: Infinity })).toThrow();
    expect(() => parseItemInput({ ...empty, purchasePrice: "20000" })).toThrow();
  });
  it("requires recipes, positive yield/price, category, and a parent for variants", () => {
    expect(() => parseItemInput({ ...base, ingredients: [] })).toThrow("between 1 and 200");
    expect(() => parseItemInput({ ...base, yieldPortions: 0 })).toThrow();
    expect(() => parseItemInput({ ...menu, suggestedPrice: 0 })).toThrow();
    expect(() => parseItemInput({ ...menu, category: " " })).toThrow("Category");
    expect(() => parseItemInput({ ...menu, type: "variant" })).toThrow("Main menu item");
    expect(parseItemInput({ ...menu, type: "variant", parentId: ids.menu })).toMatchObject({ parentId: ids.menu, category: "Original POS Category" });
  });
  it("rejects duplicate ingredients and invalid quantities", () => {
    expect(() => parseItemInput({ ...base, ingredients: [base.ingredients[0], base.ingredients[0]] })).toThrow("only once");
    expect(() => parseItemInput({ ...base, ingredients: [{ ...base.ingredients[0], quantity: -1 }] })).toThrow();
  });
  it("restricts base ingredients, menu references, unit compatibility and immutable types", () => {
    expect(() => validateReferences(base, catalog, ids.base)).not.toThrow();
    expect(() => validateReferences({ ...base, ingredients: [{ itemId: ids.menu, quantity: 1, uom: "porsi" }] }, catalog)).toThrow("valid ingredients");
    expect(() => validateReferences({ ...menu, ingredients: [{ itemId: ids.milk, quantity: 1, uom: "g" }] }, catalog)).toThrow("Cannot convert");
    expect(() => validateReferences({ ...menu, type: "variant", parentId: ids.base }, catalog)).toThrow("main menu item");
    expect(() => validateReferences(menu, catalog, ids.base)).toThrow("type cannot be changed");
    expect(() => validateReferences(base, [base, menu], ids.base)).toThrow("valid ingredients");
  });
});
