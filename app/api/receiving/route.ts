import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { parseReceiving, parseReceivingUuid } from "@/lib/receiving/model";
import { listReceivings, saveReceiving } from "@/lib/receiving/service";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireItemManager();
    const value = new URL(request.url).searchParams.get("store");
    const storeId = value ? parseReceivingUuid(value, "Toko") : undefined;
    return Response.json({ receivings: await listReceivings(storeId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const session = await requireItemManager();
    const result = await saveReceiving(parseReceiving(await readItemBody(request)), session.username);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
