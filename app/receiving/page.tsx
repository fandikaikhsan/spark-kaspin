import Link from "next/link";
import { redirect } from "next/navigation";
import { ReceivingPage } from "@/components/receiving";
import { requireItemManager } from "@/lib/items/auth";
import { ItemError } from "@/lib/items/model";
import { listStores, type Store } from "@/lib/stores";
import { listReceivingItems, listReceivings } from "@/lib/receiving/service";
import type { Receiving, ReceivingItem } from "@/lib/receiving/model";
export const dynamic = "force-dynamic";
export default async function ReceivingRoute({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const parameters = await searchParams;
  try { await requireItemManager(); }
  catch (error) { if (error instanceof ItemError && error.status === 401) redirect("/login?next=/receiving"); return <main className="shell"><h1>Access required</h1><Link href="/">Back to dashboard</Link></main>; }
  let stores: Store[] = []; let items: ReceivingItem[] = []; let receivings: Receiving[] = []; let initialError: string | null = null;
  try {
    [stores, items] = await Promise.all([listStores(true), listReceivingItems()]);
    stores.sort((a,b) => Number(b.id === parameters.store) - Number(a.id === parameters.store));
    if (stores[0]) receivings = await listReceivings(stores[0].id);
  } catch (error) { initialError = error instanceof Error ? error.message : "Receiving gagal dimuat"; }
  return <ReceivingPage key={stores[0]?.id} stores={stores} items={items} initialReceivings={receivings} initialError={initialError} />;
}
