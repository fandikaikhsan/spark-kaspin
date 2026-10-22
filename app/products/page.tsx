import Link from "next/link";
import { redirect } from "next/navigation";
import { Products } from "@/components/products";
import { requireItemManager } from "@/lib/items/auth";
import { ItemError } from "@/lib/items/model";
import { loadProductCatalog } from "@/lib/products/service";
import type { ProductCatalog } from "@/lib/products/model";
export const dynamic = "force-dynamic";
export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  try { await requireItemManager(); }
  catch (error) { if (error instanceof ItemError && error.status === 401) redirect("/login?next=/products"); return <main className="shell"><h1>Manager access required</h1><p>Only managers and owners can access Products.</p><Link href="/">Back to dashboard</Link></main>; }
  let catalog: ProductCatalog = { products: [], categories: [], items: [], bases: [] }; let initialError: string | null = null;
  try { catalog = await loadProductCatalog(); } catch (error) { initialError = error instanceof Error ? error.message : "Could not load products"; }
  return <Products initialCatalog={catalog} initialError={initialError} startCreating={(await searchParams).create === "1"} />;
}
