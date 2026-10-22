import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { listItems } from "@/lib/items/service";
import { parseBaseInput } from "@/lib/bases/model";
import { listBases, saveBase } from "@/lib/bases/service";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await requireItemManager();
    const [bases, items] = await Promise.all([listBases(), listItems()]);
    return Response.json({ bases, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    await requireItemManager();
    return Response.json({ id: await saveBase(null, parseBaseInput(await readItemBody(request))) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
