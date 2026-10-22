import Link from "next/link";
import { redirect } from "next/navigation";
import { Items } from "@/components/items";
import { requireItemManager } from "@/lib/items/auth";
import { ItemError, type Item } from "@/lib/items/model";
import { listItems } from "@/lib/items/service";

export const dynamic = "force-dynamic";

export default async function ItemsPage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  try { await requireItemManager(); }
  catch (error) {
    if (error instanceof ItemError && error.status === 401) redirect("/login?next=/items");
    return <main className="shell"><h1>Manager access required</h1><p>Only managers and owners can access Items.</p><Link href="/">Back to dashboard</Link></main>;
  }
  let initialItems: Item[] = [];
  let initialError: string | null = null;
  try { initialItems = await listItems(); }
  catch (error) { initialError = error instanceof Error ? error.message : "Could not load items"; }
  const startCreating = (await searchParams).create === "1";
  return <Items initialItems={initialItems} initialError={initialError} startCreating={startCreating} />;
}
