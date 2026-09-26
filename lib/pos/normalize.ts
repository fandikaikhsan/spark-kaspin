import type { PosTransaction } from "./types";

export type TransactionRow = {
  transaction_code: string;
  receipt_number: number;
  business_date: string;
  business_hour: number;
  occurred_at: string;
  subtotal: number;
  grand_total: number;
  payment_type: string;
};

export type ItemRow = {
  transaction_code: string;
  line_number: number;
  item_code: string;
  item_name: string;
  category: string;
  quantity: number;
  returned_quantity: number;
  gross_sales: number;
};

export function normalizeTransactions(
  transactions: PosTransaction[],
  utcOffset: string,
): { transactions: TransactionRow[]; items: ItemRow[] } {
  if (!/^[+-]\d{2}:\d{2}$/.test(utcOffset)) {
    throw new Error("POS_UTC_OFFSET must look like +07:00 or -05:00");
  }

  const transactionRows: TransactionRow[] = [];
  const itemRows: ItemRow[] = [];

  for (const transaction of transactions) {
    const match = transaction.timestamp.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!match) throw new Error(`Unexpected POS timestamp: ${transaction.timestamp}`);

    const [, businessDate, hour, minute, second] = match;
    transactionRows.push({
      transaction_code: transaction.kode,
      receipt_number: transaction.no_struk,
      business_date: businessDate,
      business_hour: Number(hour),
      occurred_at: `${businessDate}T${hour}:${minute}:${second}${utcOffset}`,
      subtotal: Number(transaction.sub_total || 0),
      grand_total: Number(transaction.grand_total || 0),
      payment_type: transaction.tipe_pembayaran || "unknown",
    });

    transaction.data_transaksi.forEach((item, lineNumber) => {
      itemRows.push({
        transaction_code: transaction.kode,
        line_number: lineNumber,
        item_code: item.kode_barang || `unknown-${lineNumber}`,
        item_name: item.nama_barang || "Unknown item",
        category: item.kategori || "Uncategorized",
        quantity: Number(item.banyak_barang || 0),
        returned_quantity: Number(item.jumlah_retur || 0),
        gross_sales: Number(item.sub_total || 0),
      });
    });
  }

  return { transactions: transactionRows, items: itemRows };
}
