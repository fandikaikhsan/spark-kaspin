import Link from "next/link";
import { redirect } from "next/navigation";
import { MenuEngineering } from "@/components/menu-engineering";
import { requireEngineeringAdmin } from "@/lib/menu-engineering/auth";
import { EngineeringError, type Catalog } from "@/lib/menu-engineering/model";
import { loadCatalog } from "@/lib/menu-engineering/service";
import { listStores } from "@/lib/stores";

export const dynamic = "force-dynamic";
export default async function MenuEngineeringPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  try { await requireEngineeringAdmin(); }
  catch (error) {
    if (error instanceof EngineeringError && error.status === 401) redirect("/login?next=/menu-engineering");
    return <main className="shell"><h1>Admin access required</h1><p><Link href="/">Back to dashboard</Link></p></main>;
  }
  const stores = await listStores();
  const requestedStore = (await searchParams).store;
  const store = stores.find((entry) => entry.id === requestedStore) || stores[0];
  let initialCatalog: Catalog = { items: [], categories: [] };
  let initialError: string | null = null;
  if (store) {
    try { initialCatalog = await loadCatalog(store.id); }
    catch (error) { initialError = error instanceof Error ? error.message : "Could not load catalog"; }
  }
  return <MenuEngineering stores={stores} initialStoreId={store?.id} initialCatalog={initialCatalog} initialError={initialError} />;
}
