import { itemErrorResponse, readItemBody, requireItemManager } from "@/lib/items/auth";
import { parseItemInput } from "@/lib/items/model";
import { listItems, saveItem } from "@/lib/items/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireItemManager();
    return Response.json({ items: await listItems() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    await requireItemManager();
    const input = parseItemInput(await readItemBody(request));
    return Response.json({ id: await saveItem(null, input) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
