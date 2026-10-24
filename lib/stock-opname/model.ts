import { ItemError } from "@/lib/items/model";
import { COUNTERS, STOCK_FIELDS, type CounterName, type StockSection } from "./template";
export type StockAnswers = Record<string, number | boolean>;
export type StockOpnameInput = { id: string; storeId: string; countDate: string; countedAt?: string; countedBy: CounterName; answers: StockAnswers };
export type StockLine = { key: string; section: StockSection; name: string; uom: string | null; note: string; quantity: number | null; needsRestock: boolean | null };
export type StockOpname = { id: string; storeId: string; countDate: string; countedAt?: string | null; countedBy: string; submittedAt: string; lines: StockLine[] };
export function parseStockUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ItemError(`${label} tidak valid`);
  return value;
}
export function parseStockOpname(value: unknown): StockOpnameInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ItemError("Data stock opname diperlukan");
  const input = value as Record<string, unknown>;
  const id = parseStockUuid(input.id, "ID pengiriman"); const storeId = parseStockUuid(input.storeId, "Toko");
  if (typeof input.countDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.countDate) || input.countDate < "0001-01-01") throw new ItemError("Pilih tanggal stock opname");
  const date = new Date(`${input.countDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.countDate) throw new ItemError("Tanggal stock opname tidak valid");
  if (!COUNTERS.includes(input.countedBy as CounterName)) throw new ItemError("Pilih nama yang melakukan stock opname");
  if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) throw new ItemError("Isi semua barang");
  const raw = input.answers as Record<string, unknown>;
  if (Object.keys(raw).length !== STOCK_FIELDS.length || Object.keys(raw).some((key) => !STOCK_FIELDS.some((field) => field.key === key))) throw new ItemError("Isi tepat 40 barang yang tersedia pada formulir");
  const answers: StockAnswers = {};
  for (const field of STOCK_FIELDS) {
    const answer = raw[field.key];
    if (field.section === "restock") {
      if (typeof answer !== "boolean") throw new ItemError(`Pilih Ya atau Tidak untuk ${field.name}`);
    } else if (typeof answer !== "number" || !Number.isFinite(answer) || answer < 0 || answer > 1e12) throw new ItemError(`Isi angka 0 sampai 1 triliun untuk ${field.name}`);
    answers[field.key] = answer as number | boolean;
  }
  if (input.countedAt !== undefined && (typeof input.countedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(input.countedAt) || !Number.isFinite(Date.parse(input.countedAt)))) throw new ItemError("Waktu penghitungan tidak valid");
  return { id, storeId, countDate: input.countDate, ...(input.countedAt !== undefined ? { countedAt: input.countedAt as string } : {}), countedBy: input.countedBy as CounterName, answers };
}
export function stockLines(input: StockOpnameInput): StockLine[] {
  return STOCK_FIELDS.map((field) => ({ key: field.key, section: field.section, name: field.name, uom: field.uom, note: field.note,
    quantity: field.section === "restock" ? null : input.answers[field.key] as number,
    needsRestock: field.section === "restock" ? input.answers[field.key] as boolean : null }));
}
