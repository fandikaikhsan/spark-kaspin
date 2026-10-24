import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ItemError } from "@/lib/items/model";
import { loadProductCatalog } from "@/lib/products/service";
import { addDays, localClock } from "@/lib/analytics/dashboard";
import type { Store } from "@/lib/stores";
import { calculateConsumption } from "./engine";
import type { CogsConfigInput } from "./config";
import type { CogsCount, CogsReceipt, CogsReport, CogsSale, CountMapping, PosMapping } from "./types";

function dbError(error: { code?: string; message: string }): never {
  if (["42P01", "42703", "PGRST205", "PGRST202"].includes(error.code || "")) throw new ItemError("Consumption engine needs its database migration. Run npm.cmd run local:migrate for local Supabase.", 503);
  if (error.code === "23505") throw new ItemError("This raw material is already linked to another count line in this store.", 409);
  if (error.code === "23503") throw new ItemError("The store, product or raw material no longer exists. Reload setup.", 409);
  throw new ItemError(`Could not load or save consumption data: ${error.message}`, 500);
}
type PageResult<T> = PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>;
async function pages<T>(query: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query(offset, offset + 999);
    if (error) dbError(error);
    rows.push(...data || []);
    if (!data || data.length < 1000) return rows;
  }
}
type PosRow = { item_code: string; product_id: string; output_quantity: number; output_uom: PosMapping["outputUom"] };
type CountRow = { field_key: string; item_id: string; conversion: number; base_uom: CountMapping["baseUom"] };
async function configuration(storeId: string) {
  const db = getSupabaseAdmin();
  const [pos, counts] = await Promise.all([
    pages<PosRow>((a,b) => db.from("cogs_pos_mappings").select("item_code,product_id,output_quantity,output_uom").eq("store_id", storeId).order("item_code").range(a,b)),
    pages<CountRow>((a,b) => db.from("cogs_count_mappings").select("field_key,item_id,conversion,base_uom").eq("store_id", storeId).order("field_key").range(a,b)),
  ]);
  return {
    posMappings: pos.map((r): PosMapping => ({ itemCode: r.item_code, productId: r.product_id, outputQuantity: Number(r.output_quantity), outputUom: r.output_uom })),
    countMappings: counts.map((r): CountMapping => ({ fieldKey: r.field_key, itemId: r.item_id, conversion: Number(r.conversion), baseUom: r.base_uom })),
  };
}

export async function saveCogsConfig(input: CogsConfigInput) {
  const db = getSupabaseAdmin();
  const { data: store, error: storeError } = await db.from("stores").select("id").eq("id", input.storeId).eq("active", true).maybeSingle();
  if (storeError) dbError(storeError);
  if (!store) throw new ItemError("Active store not found", 404);
  if (input.kind === "pos" || input.kind === "count") {
    const isPos = input.kind === "pos";
    const { data, error } = await db.from(isPos ? "products" : "items").select("base_uom").eq("id", isPos ? (input as Extract<CogsConfigInput,{kind:"pos"}>).mapping.productId : (input as Extract<CogsConfigInput,{kind:"count"}>).mapping.itemId).maybeSingle();
    if (error) dbError(error);
    if (!data) throw new ItemError("Selected catalogue record not found", 404);
    const unit = input.kind === "pos" ? input.mapping.outputUom : input.mapping.baseUom;
    if (unit !== data.base_uom) throw new ItemError("The output/base unit changed. Reload setup before saving.", 409);
  }
  let result;
  if (input.kind === "pos") {
    const row = input.mapping;
    result = await db.from("cogs_pos_mappings").upsert({ store_id: input.storeId, item_code: row.itemCode, product_id: row.productId, output_quantity: row.outputQuantity, output_uom: row.outputUom }, { onConflict: "store_id,item_code" });
  } else if (input.kind === "count") {
    const row = input.mapping;
    result = await db.from("cogs_count_mappings").upsert({ store_id: input.storeId, field_key: row.fieldKey, item_id: row.itemId, conversion: row.conversion, base_uom: row.baseUom }, { onConflict: "store_id,field_key" });
  } else if (input.kind === "delete-pos") result = await db.from("cogs_pos_mappings").delete().eq("store_id", input.storeId).eq("item_code", input.itemCode);
  else result = await db.from("cogs_count_mappings").delete().eq("store_id", input.storeId).eq("field_key", input.fieldKey);
  if (result.error) dbError(result.error);
}

type CountHeader = { id: string; count_date: string; counted_at: string | null; counted_by: string };
const header = (row: CountHeader): Omit<CogsCount,"lines"> => ({ id: row.id, date: row.count_date, countedAt: row.counted_at, countedBy: row.counted_by });
async function countLines(count: Omit<CogsCount,"lines">): Promise<CogsCount> {
  const { data, error } = await getSupabaseAdmin().from("stock_opname_lines").select("field_key,item_id,quantity,uom").eq("stock_opname_id", count.id).eq("section", "inventory").order("field_key");
  if (error) dbError(error);
  return { ...count, lines: (data || []).map((row) => ({ key: row.field_key, itemId: row.item_id, quantity: Number(row.quantity), uom: row.uom })) };
}

// Exact interval convention: opening < event time <= closing. Adjacent intervals cannot double-count an event.
export async function getCogsReport(store: Store, startDate: string, endDate: string, closingId?: string): Promise<CogsReport> {
  const db = getSupabaseAdmin();
  const [catalog, config, countRows] = await Promise.all([
    loadProductCatalog(), configuration(store.id),
    pages<CountHeader>((a,b) => db.from("stock_opnames").select("id,count_date,counted_at,counted_by").eq("store_id", store.id).gte("count_date", startDate).lte("count_date", endDate)
      .order("counted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).range(a,b)),
  ]);
  const counts = countRows.map(header);
  const closing = closingId ? counts.find((count) => count.id === closingId) : counts.find((count) => count.countedAt);
  if (closingId && !closing) throw new ItemError("Choose a closing count from this store and date range", 400);
  let opening: Omit<CogsCount,"lines"> | null = null;
  if (closing?.countedAt) {
    const { data, error } = await db.from("stock_opnames").select("id,count_date,counted_at,counted_by").eq("store_id", store.id).lt("counted_at", closing.countedAt).order("counted_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (error) dbError(error);
    opening = data?.[0] ? header(data[0]) : null;
    // Two simultaneous count submissions are ambiguous, rather than arbitrarily picking a balance.
    const { count, error: duplicateError } = await db.from("stock_opnames").select("id", { count: "exact", head: true }).eq("store_id", store.id).eq("counted_at", closing.countedAt);
    if (duplicateError) dbError(duplicateError);
    if ((count || 0) > 1) throw new ItemError("Multiple stock counts share the closing time. Resolve the duplicate counts before calculating consumption.", 409);
  }
  const interval = Boolean(opening?.countedAt && closing?.countedAt);
  const from = interval ? opening!.countedAt! : `${startDate}T00:00:00${store.utcOffset}`;
  const through = interval ? closing!.countedAt! : `${addDays(endDate,1)}T00:00:00${store.utcOffset}`;
  if (interval && Date.parse(through)-Date.parse(from)>93*86400000) throw new ItemError("These counts are more than 93 days apart. Add a closer physical count before calculating this interval.", 400);
  if (opening?.countedAt) {
    const { count, error } = await db.from("stock_opnames").select("id", { count:"exact", head:true }).eq("store_id",store.id).eq("counted_at",opening.countedAt);
    if(error) dbError(error);
    if((count||0)>1) throw new ItemError("Multiple stock counts share the opening time. Resolve the duplicate counts before calculating consumption.",409);
  }
  const orders = await pages<{transaction_code:string}>((a,b) => {
    let query = db.from("pos_transactions").select("transaction_code").eq("store_id", store.id);
    query = interval ? query.gt("occurred_at", from).lte("occurred_at", through) : query.gte("occurred_at", from).lt("occurred_at", through);
    return query.order("occurred_at").order("transaction_code").range(a,b);
  });
  const sales: CogsSale[] = [];
  const salesIssues: string[] = [];
  for (let offset=0; offset<orders.length; offset+=100) {
    const codes=orders.slice(offset,offset+100).map((order) => order.transaction_code);
    const lines = await pages<{transaction_code:string;item_code:string;item_name:string;quantity:number;returned_quantity:number}>((a,b) => db.from("pos_transaction_items").select("transaction_code,item_code,item_name,quantity,returned_quantity").eq("store_id",store.id).in("transaction_code",codes).order("transaction_code").order("line_number").range(a,b));
    const withLines=new Set(lines.map((line)=>line.transaction_code));
    if(codes.some((code)=>!withLines.has(code))) salesIssues.push("Some transactions have no synced item lines. Finish syncing transaction details before calculating theoretical usage.");
    sales.push(...lines.map((line) => ({ itemCode:line.item_code,itemName:line.item_name,quantity:Number(line.quantity),returnedQuantity:Number(line.returned_quantity) })));
  }
  const receipts: CogsReceipt[] = [];
  let lastSyncedAt: string | null = null;
  if (interval) {
    const receiptHeaders = await pages<{id:string}>((a,b) => db.from("receivings").select("id").eq("store_id",store.id).gt("received_at",from).lte("received_at",through).order("received_at").order("id").range(a,b));
    for (let offset=0; offset<receiptHeaders.length; offset+=100) {
      const lines = await pages<{item_id:string;quantity_base:number;base_uom:CogsReceipt["baseUom"]}>((a,b) => db.from("receiving_lines").select("item_id,quantity_base,base_uom").in("receiving_id",receiptHeaders.slice(offset,offset+100).map((row)=>row.id)).order("receiving_id").order("line_number").range(a,b));
      receipts.push(...lines.map((line)=>({itemId:line.item_id,quantityBase:Number(line.quantity_base),baseUom:line.base_uom})));
    }
    const firstDate=localClock(store.timeZone,new Date(from)).date, lastDate=localClock(store.timeZone,new Date(through)).date;
    const syncs = await pages<{business_date:string;confirmed_through:string;completed_at:string}>((a,b)=>db.from("cogs_sales_coverage").select("business_date,confirmed_through,completed_at").eq("store_id",store.id).gte("business_date",firstDate).lte("business_date",lastDate).order("business_date").range(a,b));
    const syncedDates=new Map(syncs.map((sync)=>[sync.business_date,sync.confirmed_through]));
    const missing:string[]=[];
    for(let day=firstDate;day<=lastDate;day=addDays(day,1)) {
      const required=Math.min(Date.parse(`${addDays(day,1)}T00:00:00${store.utcOffset}`),Date.parse(through));
      const sync=syncedDates.get(day);
      if(!sync || Date.parse(sync)<required) missing.push(day);
    }
    if(missing.length) salesIssues.push(`Sales sync has not confirmed complete coverage through the closing count for: ${missing.join(", ")}. Run a full sync of each date after its covered period ends (including a previous-day backfill when crossing midnight).`);
    lastSyncedAt=syncs.map((sync)=>sync.completed_at).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]||null;
  }
  const [openingData,closingData]=await Promise.all([opening?countLines(opening):null,closing?countLines(closing):null]);
  const result=calculateConsumption({...catalog,...config,opening:openingData,closing:closingData,sales,receipts,salesIssues});
  return {...result,storeId:store.id,startDate,endDate,opening,closing:closing||null,counts,lastSyncedAt,setup:{...config,
    items:catalog.items.map(({id,name,baseUom,purchaseUnitName,purchaseConversion})=>({id,name,baseUom,purchaseUnitName,purchaseConversion})),
    products:catalog.products.map(({id,name,type,baseUom})=>({id,name,type,baseUom}))}};
}
