import Link from "next/link";
import { redirect } from "next/navigation";
import { Bases } from "@/components/bases";
import { requireItemManager } from "@/lib/items/auth";
import { ItemError, type Item } from "@/lib/items/model";
import { listItems } from "@/lib/items/service";
import { listBases } from "@/lib/bases/service";
import type { PreparedBase } from "@/lib/bases/model";
export const dynamic = "force-dynamic";
export default async function BasesPage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  try { await requireItemManager(); }
  catch (error) {
    if (error instanceof ItemError && error.status === 401) redirect("/login?next=/bases");
    return <main className="shell"><h1>Manager access required</h1><p>Only managers and owners can access Bases.</p><Link href="/">Back to dashboard</Link></main>;
  }
  let bases: PreparedBase[] = []; let items: Item[] = []; let initialError: string | null = null;
  try { [bases, items] = await Promise.all([listBases(), listItems()]); }
  catch (error) { initialError = error instanceof Error ? error.message : "Could not load bases"; }
  return <Bases initialBases={bases} initialItems={items} initialError={initialError} startCreating={(await searchParams).create === "1"} />;
}
