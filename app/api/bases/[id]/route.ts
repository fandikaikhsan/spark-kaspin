import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { parseBaseId, parseBaseInput } from "@/lib/bases/model";
import { saveBase, deleteBase } from "@/lib/bases/service";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    await requireItemManager();
    const id = parseBaseId((await context.params).id);
    await saveBase(id, parseBaseInput(await readItemBody(request)));
    return Response.json({ id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    await requireItemManager();
    await deleteBase(parseBaseId((await context.params).id));
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
