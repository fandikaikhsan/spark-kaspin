import { describe, expect, it } from "vitest";
import { itemCost, parseItemId, parseItemInput, standardConversion } from "@/lib/items/model";

const item = {
  name: "Milk", baseUom: "ml", purchasePrice: 240000, purchaseQuantity: 2,
  purchaseUnitName: "carton", purchaseConversion: 12000,
};

describe("global purchased items and conversions", () => {
  it("accepts optional IDs and trims free-text supplier notes", () => {
    expect(parseItemInput({ ...item, id: " BB-001 ", supplier: " Market / Shop A " })).toMatchObject({ id: "BB-001", supplier: "Market / Shop A" });
    expect(parseItemInput({ ...item, id: "   " })).not.toHaveProperty("id");
    expect(parseItemInput(item).supplier).toBe("");
    for (const data of [{id: "bad/id"}, {id: 123}, {supplier: 123}, {supplier: "x".repeat(1001)}]) {
      expect(() => parseItemInput({ ...item, ...data })).toThrow();
    }
  });
  it("costs the whole purchase quantity, including its pack conversion", () => {
    const input = parseItemInput({ ...item, name: "  Milk  ", purchaseUnitName: " carton " });
    expect(input.name).toBe("Milk");
    expect(input.purchaseUnitName).toBe("carton");
    expect(itemCost(input)).toEqual({ quantityBase: 24000, unitCost: 10 });
    expect(itemCost({ ...input, purchaseQuantity: 0.5 })).toEqual({ quantityBase: 6000, unitCost: 40 });
  });

  it("allows a genuine zero reference price without accepting missing numeric values", () => {
    expect(itemCost(parseItemInput({ ...item, purchasePrice: 0 })).unitCost).toBe(0);
    for (const value of [null, "", "240000", undefined, NaN, Infinity, -1]) {
      expect(() => parseItemInput({ ...item, purchasePrice: value })).toThrow();
    }
  });

  it.each(["purchaseQuantity", "purchaseConversion"])("rejects missing, zero, negative or non-finite %s", (field) => {
    for (const value of [null, "1", undefined, 0, -1, NaN, Infinity, 1e-12, 1e13]) {
      expect(() => parseItemInput({ ...item, [field]: value })).toThrow();
    }
  });

  it("normalizes standard labels and enforces mass, volume and count conversions", () => {
    expect(parseItemInput({ ...item, purchaseUnitName: " L ", purchaseConversion: 1000 }).purchaseUnitName).toBe("l");
    expect(standardConversion("kg", "g")).toBe(1000);
    expect(standardConversion("g", "kg")).toBe(0.001);
    expect(standardConversion("ml", "l")).toBe(0.001);
    expect(standardConversion("pcs", "pcs")).toBe(1);
    expect(standardConversion("carton", "ml")).toBeNull();
    expect(() => parseItemInput({ ...item, purchaseUnitName: "l", purchaseConversion: 1 })).toThrow("1000");
    expect(() => parseItemInput({ ...item, purchaseUnitName: "kg", purchaseConversion: 1000 })).toThrow("cannot be converted");
    expect(() => standardConversion("pcs", "g")).toThrow();
  });

  it("requires names and a supported physical base unit", () => {
    for (const value of [null, [], {}, { ...item, name: " " }, { ...item, name: "x".repeat(201) },
      { ...item, purchaseUnitName: " " }, { ...item, purchaseUnitName: "x".repeat(81) }, { ...item, baseUom: "bag" }]) {
      expect(() => parseItemInput(value)).toThrow();
    }
  });

  it("accepts generated or user-entered item IDs for edits/deletes", () => {
    expect(parseItemId("BB-001")).toBe("BB-001");
    expect(parseItemId("00000000-0000-4000-8000-000000000001")).toBeTruthy();
    for (const value of [null, "", "../../items", "invalid/id", "x".repeat(81)]) expect(() => parseItemId(value)).toThrow();
  });
});
