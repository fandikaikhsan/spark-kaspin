import { BASE_UNITS, ItemError, parseItemId, standardConversion, type BaseUnit } from "@/lib/items/model";
import { EMPLOYEE_NAMES, type EmployeeName } from "@/lib/operations/employees";

// Operational catalog projection: no prices or supplier details are sent to the form.
export type ReceivingItem = { id: string; name: string; baseUom: BaseUnit; purchaseUnitName: string; updatedAt: string };
export type ReceivingLineInput = { itemId: string; quantity: number; uom: string; itemUpdatedAt: string };
export type ReceivingInput = { id: string; storeId: string; receivedBy: EmployeeName; lines: ReceivingLineInput[] };
export type Receiving = { id: string; storeId: string; receivedBy: string; receivedAt: string;
  lines: { itemId: string; name: string; quantity: number; uom: string }[] };

export function receivingUnits(item: ReceivingItem): string[] {
  const compatible = BASE_UNITS.filter((unit) => { try { return standardConversion(unit, item.baseUom) !== null; } catch { return false; } });
  return [...new Set([item.purchaseUnitName, ...compatible])];
}

export function parseReceivingUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ItemError(`${label} tidak valid`);
  return value;
}
export function parseReceiving(value: unknown): ReceivingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError("Data receiving diperlukan");
  const input = value as Record<string, unknown>;
  const id = parseReceivingUuid(input.id, "ID penerimaan");
  const storeId = parseReceivingUuid(input.storeId, "Toko");
  if (!EMPLOYEE_NAMES.includes(input.receivedBy as EmployeeName)) throw new ItemError("Pilih nama penerima barang");
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) throw new ItemError("Tambahkan 1 sampai 100 barang");
  const seen = new Set<string>();
  const lines = input.lines.map((value, index): ReceivingLineInput => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError(`Pilih barang pada baris ${index + 1}`);
    const row = value as Record<string, unknown>;
    const itemId = parseItemId(row.itemId);
    if (seen.has(itemId)) throw new ItemError("Barang yang sama cukup satu baris. Gabungkan jumlahnya.");
    seen.add(itemId);
    if (typeof row.quantity !== "number" || !Number.isFinite(row.quantity) || row.quantity < 1e-9 || row.quantity > 1e12) throw new ItemError(`Jumlah baris ${index + 1} harus lebih dari 0 (minimal 0,000000001)`);
    // Keep PostgreSQL's microseconds intact when comparing the selected item revision.
    if (typeof row.itemUpdatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(row.itemUpdatedAt) || !Number.isFinite(Date.parse(row.itemUpdatedAt))) throw new ItemError("Data barang tidak lengkap. Muat ulang halaman.");
    if (typeof row.uom !== "string" || !row.uom.trim() || row.uom.trim().length > 80) throw new ItemError(`Pilih satuan pada baris ${index + 1}`);
    const uom = row.uom.trim();
    return { itemId, quantity: row.quantity, uom: BASE_UNITS.includes(uom.toLowerCase() as BaseUnit) ? uom.toLowerCase() : uom, itemUpdatedAt: row.itemUpdatedAt };
  });
  return { id, storeId, receivedBy: input.receivedBy as EmployeeName, lines };
}
