import { engineeringErrorResponse, readEngineeringBody, requireEngineeringAdmin } from "@/lib/menu-engineering/auth";
import { parseId, parseItemInput } from "@/lib/menu-engineering/model";
import { deleteItem, saveItem } from "@/lib/menu-engineering/service";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    await requireEngineeringAdmin();
    const id = parseId((await context.params).id);
    const body = await readEngineeringBody(request);
    const storeId = parseId(body.storeId, "Store ID");
    await saveItem(storeId, id, parseItemInput(body.item));
    return Response.json({ id });
  } catch (error) { return engineeringErrorResponse(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    await requireEngineeringAdmin();
    const id = parseId((await context.params).id);
    const storeId = parseId(new URL(request.url).searchParams.get("store"), "Store ID");
    await deleteItem(storeId, id);
    return new Response(null, { status: 204 });
  } catch (error) { return engineeringErrorResponse(error); }
}
