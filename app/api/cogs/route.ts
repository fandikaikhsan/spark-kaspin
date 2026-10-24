import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { ItemError } from "@/lib/items/model";
import { parseStockUuid } from "@/lib/stock-opname/model";
import { isBusinessDate, localClock } from "@/lib/analytics/dashboard";
import { listStores } from "@/lib/stores";
import { getCogsReport, saveCogsConfig } from "@/lib/cogs/service";
import { parseCogsConfig } from "@/lib/cogs/config";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireItemManager();
    const params=new URL(request.url).searchParams;
    const storeId=parseStockUuid(params.get("store"),"Store"), start=params.get("start")||"", end=params.get("end")||"";
    if(!isBusinessDate(start)||!isBusinessDate(end)||start>end||Date.parse(end)-Date.parse(start)>31*86400000) throw new ItemError("Choose a date range of at most 32 days");
    const store=(await listStores(true)).find((store)=>store.id===storeId);
    if(!store) throw new ItemError("Store not found",404);
    if(end>localClock(store.timeZone).date) throw new ItemError("Choose today or an earlier date");
    const closing=params.get("closing");
    return Response.json(await getCogsReport(store,start,end,closing?parseStockUuid(closing,"Closing count"):undefined),{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return itemErrorResponse(error); }
}
export async function POST(request: Request) {
  try { await requireItemManager(); await saveCogsConfig(parseCogsConfig(await readItemBody(request))); return Response.json({saved:true},{headers:{"Cache-Control":"no-store"}}); }
  catch(error) { return itemErrorResponse(error); }
}
