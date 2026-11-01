import type { Metadata } from "next";
import { StockOpnamePage } from "@/components/stock-opname";
import { businessDateForTimeZone, listStores, type Store } from "@/lib/stores";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stock opname · Sarkop", robots: { index: false, follow: false } };
export default async function EmployeeStockOpname() {
  let stores: Store[] = [], error: string | null = null;
  try { stores = await listStores(true); }
  catch { error = "Formulir belum tersedia. Hubungi pengelola toko atau muat ulang halaman."; }
  return <StockOpnamePage employeeMode stores={stores} initialSubmissions={[]} initialError={error} initialDate={businessDateForTimeZone(stores[0]?.timeZone || "Asia/Makassar")} />;
}
