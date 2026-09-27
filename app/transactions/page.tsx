import { TransactionsTable } from "@/components/transactions-table";
import { demoTransactionPage } from "@/lib/analytics/demo";
import { hasSupabaseConfig } from "@/lib/env";
import { businessDateForTimeZone, listStores } from "@/lib/stores";
import { getTransactionsPage } from "@/lib/transactions";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; date?: string; page?: string; pageSize?: string }>;
}) {
  const parameters = await searchParams;
  if (!hasSupabaseConfig()) {
    const date = parameters.date || businessDateForTimeZone("Asia/Jakarta");
    return <TransactionsTable initialData={demoTransactionPage(date)} />;
  }

  const stores = await listStores(true);
  if (!stores.length) throw new Error("No active stores are configured. Open /settings to add one.");
  const store = stores.find((candidate) => candidate.id === parameters.store) || stores[0];
  const date = parameters.date || businessDateForTimeZone(store.timeZone);
  const page = Math.max(1, Number(parameters.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(parameters.pageSize) || 20));
  const data = await getTransactionsPage(store, date, stores, page, pageSize);
  return <TransactionsTable initialData={data} />;
}
