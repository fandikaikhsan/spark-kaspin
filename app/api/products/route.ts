import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { parseProductInput } from "@/lib/products/model";
import { loadProductCatalog, saveProduct } from "@/lib/products/service";
export const dynamic = "force-dynamic";
export async function GET() {
  try { await requireItemManager(); return Response.json(await loadProductCatalog(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return itemErrorResponse(error); }
}
export async function POST(request: Request) {
  try { await requireItemManager(); return Response.json({ id: await saveProduct(null, parseProductInput(await readItemBody(request))) }, { status: 201, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return itemErrorResponse(error); }
}
