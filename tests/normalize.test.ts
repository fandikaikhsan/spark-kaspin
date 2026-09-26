import { describe, expect, it } from "vitest";
import { normalizeTransactions } from "@/lib/pos/normalize";
import type { PosTransaction } from "@/lib/pos/types";

describe("POS normalization", () => {
  it("creates an idempotent transaction row and hourly item rows", () => {
    const transaction: PosTransaction = {
      kode: "TX-1",
      no_struk: 42,
      timestamp: "2026-09-27 08:14:03",
      sub_total: 20_000,
      grand_total: 22_000,
      tipe_pembayaran: "tunai",
      data_transaksi: [{
        nama_barang: "Coffee",
        kode_barang: "CF-1",
        kategori: "Drink",
        banyak_barang: 2,
        harga_jual: 10_000,
        sub_total: 20_000,
        jumlah_retur: 0,
        is_retur: false,
      }],
    };

    const result = normalizeTransactions([transaction], "+07:00");
    expect(result.transactions[0]).toMatchObject({
      transaction_code: "TX-1",
      business_date: "2026-09-27",
      business_hour: 8,
      occurred_at: "2026-09-27T08:14:03+07:00",
    });
    expect(result.items[0]).toMatchObject({
      transaction_code: "TX-1",
      line_number: 0,
      item_code: "CF-1",
      quantity: 2,
    });
  });
});
