import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { parseStockEntry, parseStockOpname, parseStockUuid } from "@/lib/stock-opname/model";
import { listStockOpnames, saveStockOpname, saveAutomaticStockOpname } from "@/lib/stock-opname/service";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { await requireItemManager(); const value = new URL(request.url).searchParams.get("store"); const storeId = value ? parseStockUuid(value, "Toko") : undefined;
    return Response.json({ submissions: await listStockOpnames(storeId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
export async function POST(request: Request) {
  try { const session = await requireItemManager(); const body = await readItemBody(request);
    const result = body && typeof body === "object" && "automaticTime" in body && body.automaticTime === true
      ? await saveAutomaticStockOpname(parseStockEntry(body), session.username)
      : await saveStockOpname(parseStockOpname(body), session.username);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return itemErrorResponse(error); }
}
