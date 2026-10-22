import { describe, expect, it } from "vitest";
import { baseCost, ingredientUnits, parseBaseInput } from "@/lib/bases/model";
import type { Item } from "@/lib/items/model";
const milk: Item = { id: "MILK", name: "Milk", baseUom: "ml", purchasePrice: 245000, purchaseQuantity: 1, purchaseUnitName: "carton", purchaseConversion: 12000, purchaseUnitId: "unit", updatedAt: "2026-10-22" };
const input = { name: "Carbonara", baseUom: "porsi", yieldQuantity: 22, ingredients: [{ itemId: "MILK", quantity: 1000, uom: "ml" }] };
describe("prepared base costing and validation", () => {
  it("matches the workbook's Carbonara batch and portion costs, including 5%", () => {
    const definitions = [["Cream", "ml", 73000, 1000, 1000], ["Milk", "ml", 245000, 12000, 1000], ["Cheddar", "g", 110000, 2000, 250], ["Margarine", "g", 9000, 200, 120], ["Chicken", "g", 93000, 1000, 50], ["Pepper", "g", 40000, 500, 10], ["Flour", "g", 14000, 1000, 120]] as const;
    const items: Item[] = definitions.map(([name, baseUom, purchasePrice, purchaseConversion]) => ({ ...milk, id: name, name, baseUom, purchasePrice, purchaseConversion, purchaseUnitName: "pack" }));
    const ingredients = definitions.map(([itemId, uom, , , quantity]) => ({ itemId, uom, quantity }));
    const cost = baseCost({ ingredients, yieldQuantity: 22 }, items);
    expect(cost.ingredientCost).toBeCloseTo(119696.6666667, 5);
    expect(cost.totalProductionCost).toBeCloseTo(125681.5, 5);
    expect(cost.unitCost).toBeCloseTo(5712.7954545, 5);
  });
  it("converts standard units and item-specific packs using current item prices", () => {
    const line = { itemId: milk.id, quantity: 1, uom: "l" };
    const a = baseCost({ ingredients: [line], yieldQuantity: 10 }, [milk]);
    expect(a.ingredientCost).toBeCloseTo(245000 / 12);
    expect(baseCost({ ingredients: [{ ...line, uom: "carton" }], yieldQuantity: 10 }, [milk]).ingredientCost).toBe(245000);
    expect(baseCost({ ingredients: [line], yieldQuantity: 10 }, [{ ...milk, purchasePrice: 490000 }]).unitCost).toBeCloseTo(a.unitCost * 2);
    expect(ingredientUnits(milk)).toEqual(["ml", "l", "carton"]);
  });
  it("rejects missing ingredients, incompatible units and unrelated pack names", () => {
    expect(() => baseCost(parseBaseInput(input), [])).toThrow("unavailable");
    for (const uom of ["kg", "porsi", "other pack"]) expect(() => baseCost({ ...parseBaseInput(input), ingredients: [{ itemId: "MILK", quantity: 1, uom }] }, [milk])).toThrow();
    for (const ingredients of [[], undefined, Array(201).fill(input.ingredients[0])]) expect(() => parseBaseInput({ ...input, ingredients })).toThrow();
  });
  it("accepts portions and measured outputs without inventing portion conversions", () => {
    expect(parseBaseInput({ ...input, id: " BASE-001 ", name: " Carbonara " })).toMatchObject({ id: "BASE-001", name: "Carbonara", baseUom: "porsi", yieldQuantity: 22 });
    expect(parseBaseInput({ ...input, id: " ", baseUom: "g", yieldQuantity: 2200 })).not.toHaveProperty("id");
    expect(() => parseBaseInput({ ...input, baseUom: "carton" })).toThrow();
    expect(() => parseBaseInput({ ...input, id: "invalid/id" })).toThrow();
  });
  it("rejects invalid yields, quantities, names, IDs and units", () => {
    for (const value of [0, -1, "22", NaN, Infinity, 1e13, null]) {
      expect(() => parseBaseInput({ ...input, yieldQuantity: value })).toThrow();
      expect(() => parseBaseInput({ ...input, ingredients: [{ ...input.ingredients[0], quantity: value }] })).toThrow();
    }
    for (const value of [{ ...input, name: " " }, { ...input, name: "x".repeat(201) }, { ...input, id: 12 },
      { ...input, ingredients: [{ ...input.ingredients[0], itemId: "" }] }, { ...input, ingredients: [{ ...input.ingredients[0], uom: "" }] }]) expect(() => parseBaseInput(value)).toThrow();
  });
});
