import { itemErrorResponse, readItemBody, requireItemManager } from "@/lib/items/auth";
import { parseItemId, parseItemInput } from "@/lib/items/model";
import { deleteItem, saveItem } from "@/lib/items/service";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    await requireItemManager();
    const id = parseItemId((await context.params).id);
    await saveItem(id, parseItemInput(await readItemBody(request)));
    return Response.json({ id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    await requireItemManager();
    await deleteItem(parseItemId((await context.params).id));
    return new Response(null, { status: 204 });
  } catch (error) { return itemErrorResponse(error); }
}
