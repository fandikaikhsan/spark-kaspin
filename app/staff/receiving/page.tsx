import type { Metadata } from "next";
import { ReceivingPage } from "@/components/receiving";
import { listStores, type Store } from "@/lib/stores";
import { listReceivingItems } from "@/lib/receiving/service";
import type { ReceivingItem } from "@/lib/receiving/model";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Receiving · Sarkop", robots: { index: false, follow: false } };
export default async function EmployeeReceiving() {
  let stores: Store[] = [], items: ReceivingItem[] = [], error: string | null = null;
  try { [stores, items] = await Promise.all([listStores(true), listReceivingItems()]); }
  catch { error = "Formulir belum tersedia. Hubungi pengelola toko atau muat ulang halaman."; }
  return <ReceivingPage employeeMode stores={stores} items={items} initialReceivings={[]} initialError={error} />;
}
