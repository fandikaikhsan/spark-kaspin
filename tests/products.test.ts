import { describe, expect, it } from "vitest";
import { parseProductInput, parseCategoryName, productCost, productIngredientUnits } from "@/lib/products/model";
import type { Item } from "@/lib/items/model";
import type { PreparedBase } from "@/lib/bases/model";
const raw: Item = { id: "MILK", name: "Milk", baseUom: "ml", purchasePrice: 100000, purchaseQuantity: 1, purchaseUnitName: "carton", purchaseConversion: 10000, purchaseUnitId: "u", updatedAt: "2026-10-22" };
const base: PreparedBase = { id: "SAUCE", name: "Sauce", baseUom: "porsi", yieldQuantity: 10, recipeId: "r", updatedAt: "2026-10-22", ingredients: [{ itemId: raw.id, quantity: 1000, uom: "ml" }] };
const input = { name: "Pasta", type: "menu", salesPrice: 30000, baseUom: "porsi", yieldQuantity: 1, ingredients: [{ kind: "base", ingredientId: base.id, quantity: 1, uom: "porsi" }, { kind: "item", ingredientId: raw.id, quantity: 0.1, uom: "l" }] };
describe("product recipes and categories", () => {
  it("divides whole-batch cost by yield before comparing it with the per-unit price", () => {
    const value = parseProductInput({ ...input, yieldQuantity: 20, baseUom: "porsi" });
    const cost = productCost(value, [raw], [base]);
    expect(cost.totalProductionCost).toBe(2050);
    expect(cost.unitCost).toBe(102.5);
    expect(cost.margin).toBe(29897.5);
    expect(cost.costPercentage).toBeCloseTo(102.5 / 30000 * 100);
    for (const yieldQuantity of [undefined, 0, -1, null, "20", NaN, Infinity, 1e13]) expect(() => parseProductInput({ ...input, yieldQuantity })).toThrow();
    expect(() => parseProductInput({ ...input, baseUom: "pack" })).toThrow();
  });
  it("costs one sold unit using Items and Bases, with no second 5% allowance", () => {
    const cost = productCost(parseProductInput(input), [raw], [base]);
    expect(cost.lineCosts).toEqual([1050, 1000]);
    expect(cost.totalProductionCost).toBe(2050);
    expect(cost.margin).toBe(27950);
    expect(cost.costPercentage).toBeCloseTo(2050 / 30000 * 100);
    expect(cost.marginPercentage).toBeCloseTo(27950 / 30000 * 100);
  });
  it("supports direct resale and zero-price add-ons without dividing by zero", () => {
    const water: Item = { ...raw, id: "WATER", baseUom: "pcs", purchaseUnitName: "pack", purchaseConversion: 12, purchasePrice: 24000 };
    const value = parseProductInput({ name: "Water", type: "addon", salesPrice: 0, baseUom: "pcs", yieldQuantity: 1, ingredients: [{ kind: "item", ingredientId: water.id, quantity: 1, uom: "pcs" }] });
    expect(productCost(value, [water], [])).toMatchObject({ totalProductionCost: 2000, margin: -2000, costPercentage: null, marginPercentage: null });
  });
  it("converts measured base units and protects portions from invented conversions", () => {
    const measured = { ...base, baseUom: "g" as const, yieldQuantity: 1000 };
    expect(productCost({ salesPrice: 30000, ingredients: [{ kind: "base", ingredientId: base.id, quantity: .1, uom: "kg" }] }, [raw], [measured]).totalProductionCost).toBe(1050);
    expect(productIngredientUnits({ kind: "base", ingredientId: base.id }, [raw], [base])).toEqual(["porsi"]);
    expect(productIngredientUnits({ kind: "base", ingredientId: base.id }, [raw], [measured])).toEqual(["g", "kg"]);
    expect(productIngredientUnits({ kind: "item", ingredientId: raw.id }, [raw], [base])).toEqual(["ml", "l", "carton"]);
    expect(() => productCost({ salesPrice: 1, ingredients: [{ kind: "base", ingredientId: base.id, quantity: 1, uom: "g" }] }, [raw], [base])).toThrow("compatible");
  });
  it("keeps ingredient namespaces distinct even when Item and Base IDs match", () => {
    const sameId = { ...base, id: raw.id };
    expect(productCost({ salesPrice: 1, ingredients: [{ kind: "base", ingredientId: raw.id, quantity: 1, uom: "porsi" }] }, [raw], [sameId]).totalProductionCost).toBe(1050);
    expect(() => productCost(parseProductInput(input), [], [])).toThrow();
  });
  it("requires a parent only for variants and a complete recipe for every product", () => {
    expect(parseProductInput({ ...input, type: "variant", parentProductId: "MAIN" }).parentProductId).toBe("MAIN");
    for (const value of [{ ...input, type: "variant" }, { ...input, type: "variant", id: "MAIN", parentProductId: "MAIN" }, { ...input, parentProductId: "MAIN" }, { ...input, ingredients: [] }, { ...input, ingredients: [{ ...input.ingredients[0], kind: "product" }] }, { ...input, ingredients: Array(201).fill(input.ingredients[0]) }]) expect(() => parseProductInput(value)).toThrow();
  });
  it("validates IDs, names, numbers and category selection", () => {
    expect(parseProductInput({ ...input, id: " MENU-001 ", name: " Pasta " })).toMatchObject({ id: "MENU-001", name: "Pasta", categoryId: null });
    expect(parseProductInput({ ...input, id: " " })).not.toHaveProperty("id");
    expect(parseCategoryName(" Coffee ")).toBe("Coffee");
    for (const name of [" ", null, 1, "x".repeat(201)]) expect(() => parseCategoryName(name)).toThrow();
    for (const salesPrice of [undefined, null, "100", -1, NaN, Infinity, 1e13]) expect(() => parseProductInput({ ...input, salesPrice })).toThrow();
    for (const quantity of [0, -1, "1", NaN, Infinity, 1e13]) expect(() => parseProductInput({ ...input, ingredients: [{ ...input.ingredients[0], quantity }] })).toThrow();
    for (const value of [{ ...input, categoryId: "not-a-category" }, { ...input, name: "" }, { ...input, id: "bad/id" }, { ...input, id: 1 }, { ...input, type: "raw_material" }, { ...input, ingredients: [{ ...input.ingredients[0], uom: "" }] }]) expect(() => parseProductInput(value)).toThrow();
  });
});
