import { describe, expect, it } from "vitest";
import { parseStockOpname, stockLines } from "@/lib/stock-opname/model";
import { COUNTERS, STOCK_FIELDS } from "@/lib/stock-opname/template";

const input = () => ({ id: "00000000-0000-4000-8000-000000000001", storeId: "00000000-0000-4000-8000-000000000002", countDate: "2026-10-22", countedBy: COUNTERS[0],
  answers: Object.fromEntries(STOCK_FIELDS.map((field) => [field.key, field.section === "restock" ? false : 0])) });
describe("Fixed stock opname form", () => {
  it("accepts zero, fractions and explicit Tidak; preserves count units and separates operational sections", () => {
    const value = input(); value.answers.sosis = 1.5;
    const lines = stockLines(parseStockOpname(value));
    expect(lines).toHaveLength(40);
    expect(lines.filter((line) => line.section === "prep")).toHaveLength(6);
    expect(lines.filter((line) => line.section === "inventory")).toHaveLength(22);
    expect(lines.filter((line) => line.section === "restock")).toHaveLength(12);
    expect(lines.find((line) => line.key === "sosis")).toMatchObject({ quantity: 1.5, uom: "Pack", needsRestock: null });
    expect(lines.find((line) => line.key === "bayam")).toMatchObject({ quantity: null, needsRestock: false });
    expect(lines.find((line) => line.key === "dada-ayam-fillet")?.note).toBe("Untuk Sous Vide");
    expect(lines.find((line) => line.key === "paha-ayam-fillet")?.note).toBe("Untuk Ayam Suwir");
    expect(lines.find((line) => line.key === "chatramue")?.note).toBe("Thai Tea, untuk Tesu");
  });
  it.each(["", "2 pack", "2", null, undefined, -1, NaN, Infinity, 1e12 + 1, true])("rejects invalid numeric answer %s", (answer) => {
    const value = input(); expect(() => parseStockOpname({ ...value, answers: { ...value.answers, sosis: answer } })).toThrow();
  });
  it.each(["Ya", "Tidak", 0, 1, null, undefined, ""])("requires explicit boolean restock answer %s", (answer) => {
    const value = input(); expect(() => parseStockOpname({ ...value, answers: { ...value.answers, bayam: answer } })).toThrow();
  });
  it("rejects incomplete, extra and substituted fields", () => {
    const value = input(); delete value.answers.sosis;
    expect(() => parseStockOpname(value)).toThrow(); value.answers.unknown = 1;
    expect(() => parseStockOpname(value)).toThrow(); value.answers.sosis = 0;
    expect(() => parseStockOpname(value)).toThrow();
  });
  it.each(["2026-02-30", "2026-13-01", "22/10/2026", "0000-01-01", "", null])("rejects invalid date %s", (countDate) => { expect(() => parseStockOpname({ ...input(), countDate })).toThrow(); });
  it("validates store, submission and counter; ignores spoofed line metadata", () => {
    for (const patch of [{ storeId: "bad" }, { id: "bad" }, { countedBy: "Unknown" }]) expect(() => parseStockOpname({ ...input(), ...patch })).toThrow();
    for (const countedBy of COUNTERS) expect(parseStockOpname({ ...input(), countedBy }).countedBy).toBe(countedBy);
    expect(parseStockOpname({ ...input(), submittedBy: "spoofed", prices: 1000 })).not.toHaveProperty("submittedBy");
  });
});
