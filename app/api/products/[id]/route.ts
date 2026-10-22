import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { parseProductId, parseProductInput } from "@/lib/products/model";
import { saveProduct, deleteProduct } from "@/lib/products/service";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try { await requireItemManager(); const id = parseProductId((await context.params).id); await saveProduct(id, parseProductInput(await readItemBody(request))); return Response.json({ id }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return itemErrorResponse(error); }
}
export async function DELETE(_request: Request, context: Context) {
  try { await requireItemManager(); await deleteProduct(parseProductId((await context.params).id)); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return itemErrorResponse(error); }
}
