import Link from "next/link";
import { redirect } from "next/navigation";
import { StockOpnamePage } from "@/components/stock-opname";
import { requireItemManager } from "@/lib/items/auth";
import { ItemError } from "@/lib/items/model";
import { listStores, businessDateForTimeZone, type Store } from "@/lib/stores";
import { listStockOpnames } from "@/lib/stock-opname/service";
import type { StockOpname } from "@/lib/stock-opname/model";
export const dynamic = "force-dynamic";
export default async function StockOpname() {
  try { await requireItemManager(); }
  catch (error) { if (error instanceof ItemError && error.status === 401) redirect("/login?next=/stock-opname"); return <main className="shell"><h1>Access required</h1><Link href="/">Back to dashboard</Link></main>; }
  let stores: Store[] = []; let submissions: StockOpname[] = []; let initialError: string | null = null;
  try { stores = await listStores(true); if (stores[0]) submissions = await listStockOpnames(stores[0].id); }
  catch (error) { initialError = error instanceof Error ? error.message : "Stock opname gagal dimuat"; }
  return <StockOpnamePage stores={stores} initialSubmissions={submissions} initialError={initialError} initialDate={businessDateForTimeZone(stores[0]?.timeZone || "Asia/Makassar")} />;
}
