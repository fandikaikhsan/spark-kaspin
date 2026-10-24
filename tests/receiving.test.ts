import { describe, expect, it } from "vitest";
import { parseReceiving, receivingUnits } from "@/lib/receiving/model";
import { EMPLOYEE_NAMES } from "@/lib/operations/employees";
const input = () => ({ id: "00000000-0000-4000-8000-000000000001", storeId: "00000000-0000-4000-8000-000000000002", receivedBy: EMPLOYEE_NAMES[0],
  lines: [{ itemId: "BEEF-001", quantity: 10, uom: "g", itemUpdatedAt: "2026-10-22T12:00:00.123456+00:00" }, { itemId: "MILK", quantity: 1.5, uom: "l", itemUpdatedAt: "2026-10-22T12:00:00Z" }] });
describe("Quantity-only receiving", () => {
  it("offers only compatible standard units and the item's own purchase unit", () => {
    const item = { id: "BEEF", name: "Beef", baseUom: "g" as const, purchaseUnitName: "pack", updatedAt: "2026-10-24T00:00:00Z" };
    expect(receivingUnits(item)).toEqual(["pack", "g", "kg"]);
    expect(receivingUnits({ ...item, baseUom: "ml", purchaseUnitName: "bottle" })).toEqual(["bottle", "ml", "l"]);
    expect(receivingUnits({ ...item, baseUom: "pcs", purchaseUnitName: "pcs" })).toEqual(["pcs"]);
    for (const uom of ["", " ", null, undefined]) expect(() => parseReceiving({ ...input(), lines: [{ ...input().lines[0], uom }] })).toThrow();
  });
  it("accepts multiple items and fractions, preserving the selected catalog revision", () => {
    const value = input(); expect(parseReceiving(value)).toEqual(value);
    for (const receivedBy of EMPLOYEE_NAMES) expect(parseReceiving({ ...value, receivedBy }).receivedBy).toBe(receivedBy);
  });
  it.each([0, -1, 1e-10, 1e12 + 1, NaN, Infinity, "", "2", "2 pack", null, true])("rejects invalid quantity %s", (quantity) => {
    const value = input(); expect(() => parseReceiving({ ...value, lines: [{ ...value.lines[0], quantity }] })).toThrow();
  });
  it("requires one or more existing-item references and rejects duplicate items", () => {
    const value = input();
    for (const lines of [[], [null], [{ ...value.lines[0], itemId: "" }], [{ ...value.lines[0], itemId: "../wrong" }], [value.lines[0], value.lines[0]], Array.from({ length: 101 }, (_, i) => ({ ...value.lines[0], itemId: `ITEM-${i}` }))]) expect(() => parseReceiving({ ...value, lines })).toThrow();
  });
  it("requires store, receiver and catalog revision; ignores spoofed prices/conversions and receipt time", () => {
    const value = input();
    for (const patch of [{ storeId: "bad" }, { id: "bad" }, { receivedBy: "Unknown" }, { lines: [{ ...value.lines[0], itemUpdatedAt: "bad" }] }]) expect(() => parseReceiving({ ...value, ...patch })).toThrow();
    expect(parseReceiving({ ...value, receivedAt: "2000-01-01", submittedBy: "spoofed", lines: value.lines.map((line) => ({ ...line, price: 100, purchaseConversion: 999 })) })).toEqual(value);
  });
});
