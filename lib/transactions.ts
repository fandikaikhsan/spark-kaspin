import { summarizeStore, type Store } from "@/lib/stores";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type {
  TransactionItem,
  TransactionPage,
  TransactionReceipt,
} from "@/lib/analytics/types";

type TransactionRow = {
  transaction_code: string;
  receipt_number: number;
  business_date: string;
  occurred_at: string;
  subtotal: number;
  grand_total: number;
  payment_type: string;
};

type ItemRow = {
  transaction_code: string;
  line_number: number;
  item_code: string;
  item_name: string;
  category: string;
  quantity: number;
  returned_quantity: number;
  gross_sales: number;
};

function mapItem(row: ItemRow): TransactionItem {
  return {
    lineNumber: Number(row.line_number),
    itemCode: row.item_code,
    itemName: row.item_name,
    category: row.category,
    quantity: Number(row.quantity),
    returnedQuantity: Number(row.returned_quantity),
    grossSales: Number(row.gross_sales),
  };
}

async function loadItems(storeId: string, transactionCodes: string[]) {
  const grouped = new Map<string, TransactionItem[]>();
  if (!transactionCodes.length) return grouped;

  const { data, error } = await getSupabaseAdmin()
    .from("pos_transaction_items")
    .select(
      "transaction_code,line_number,item_code,item_name,category,quantity,returned_quantity,gross_sales",
    )
    .eq("store_id", storeId)
    .in("transaction_code", transactionCodes)
    .order("line_number", { ascending: true });
  if (error) throw new Error(`Could not load transaction items: ${error.message}`);

  for (const row of (data || []) as ItemRow[]) {
    const items = grouped.get(row.transaction_code) || [];
    items.push(mapItem(row));
    grouped.set(row.transaction_code, items);
  }
  return grouped;
}

export async function getTransactionsPage(
  store: Store,
  date: string,
  stores: Store[] = [store],
  requestedPage = 1,
  requestedPageSize = 20,
): Promise<TransactionPage> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  const pageSize = Math.min(50, Math.max(1, Math.floor(requestedPageSize)));
  const page = Math.max(1, Math.floor(requestedPage));
  const from = (page - 1) * pageSize;

  const { data, error, count } = await getSupabaseAdmin()
    .from("pos_transactions")
    .select(
      "transaction_code,receipt_number,business_date,occurred_at,subtotal,grand_total,payment_type",
      { count: "exact" },
    )
    .eq("store_id", store.id)
    .eq("business_date", date)
    .order("occurred_at", { ascending: false })
    .order("transaction_code", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(`Could not load transactions: ${error.message}`);

  const rows = (data || []) as TransactionRow[];
  const itemsByTransaction = await loadItems(
    store.id,
    rows.map((row) => row.transaction_code),
  );
  const transactions: TransactionReceipt[] = rows.map((row) => ({
    transactionCode: row.transaction_code,
    receiptNumber: Number(row.receipt_number),
    businessDate: row.business_date,
    occurredAt: row.occurred_at,
    subtotal: Number(row.subtotal),
    grandTotal: Number(row.grand_total),
    paymentType: row.payment_type,
    items: itemsByTransaction.get(row.transaction_code) || [],
  }));
  const totalCount = count || 0;

  return {
    date,
    store: summarizeStore(store),
    stores: stores.map(summarizeStore),
    transactions,
    page,
    pageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  };
}

export async function getRecentTransactions(store: Store, date: string, limit = 8) {
  const page = await getTransactionsPage(store, date, [store], 1, limit);
  // The feed reads like a kitchen rail: oldest at the left, newest at the right.
  return page.transactions.reverse();
}
