import { engineeringErrorResponse, readEngineeringBody, requireEngineeringAdmin } from "@/lib/menu-engineering/auth";
import { parseId, parseItemInput } from "@/lib/menu-engineering/model";
import { loadCatalog, saveItem } from "@/lib/menu-engineering/service";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireEngineeringAdmin();
    const storeId = parseId(new URL(request.url).searchParams.get("store"), "Store ID");
    return Response.json(await loadCatalog(storeId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return engineeringErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    await requireEngineeringAdmin();
    const body = await readEngineeringBody(request);
    const storeId = parseId(body.storeId, "Store ID");
    const id = await saveItem(storeId, null, parseItemInput(body.item));
    return Response.json({ id }, { status: 201 });
  } catch (error) { return engineeringErrorResponse(error); }
}
