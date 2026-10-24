import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({db:{from:vi.fn()},catalog:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({getSupabaseAdmin:()=>mocks.db}));
vi.mock("@/lib/products/service",()=>({loadProductCatalog:mocks.catalog}));
import { getCogsReport, saveCogsConfig } from "@/lib/cogs/service";
import type { Store } from "@/lib/stores";

type Row=Record<string,unknown>;
let tables:Record<string,Row[]>;
// A small query double applies real filters/ranges so store boundaries, timestamps,
// missing lines and Supabase's 1000-row page limit are exercised through the loader.
function query(table:string) {
  const filters:((row:Row)=>boolean)[]=[];
  const sorting:{field:string;ascending:boolean}[]=[];
  let from=0,to=999,head=false,single=false;
  const builder={
    select:(_fields:string,options?:{head?:boolean})=>{head=Boolean(options?.head);return builder;},
    eq:(key:string,value:unknown)=>{filters.push((row)=>row[key]===value);return builder;},
    gt:(key:string,value:string)=>{filters.push((row)=>row[key]!==null&&String(row[key])>value);return builder;},
    gte:(key:string,value:string)=>{filters.push((row)=>row[key]!==null&&String(row[key])>=value);return builder;},
    lt:(key:string,value:string)=>{filters.push((row)=>row[key]!==null&&String(row[key])<value);return builder;},
    lte:(key:string,value:string)=>{filters.push((row)=>row[key]!==null&&String(row[key])<=value);return builder;},
    in:(key:string,values:unknown[])=>{filters.push((row)=>values.includes(row[key]));return builder;},
    order:(field:string,options?:{ascending?:boolean})=>{sorting.push({field,ascending:options?.ascending!==false});return builder;},
    range:(a:number,b:number)=>{from=a;to=b;return builder;},
    limit:(count:number)=>{to=count-1;return builder;},
    maybeSingle:()=>{single=true;return builder;},
    then:(resolve:(value:unknown)=>unknown)=>{
      const filtered=(tables[table]||[]).filter((row)=>filters.every((filter)=>filter(row))).sort((a,b)=>{
        for(const sort of sorting){const x=a[sort.field],y=b[sort.field];if(x===y)continue;if(x===null||x===undefined)return 1;if(y===null||y===undefined)return -1;const result=x<y?-1:1;return sort.ascending?result:-result;}return 0;
      });
      const rows=filtered.slice(from,to+1);
      return Promise.resolve(resolve({data:head?null:single?rows[0]||null:rows,error:null,count:filtered.length}));
    },
  };
  return builder;
}
const store:Store={id:"STORE-A",name:"Palu",timeZone:"Asia/Makassar",utcOffset:"+08:00",active:true,isDefault:true};
const stamp=(day:number,hour=12)=>`2026-10-${day}T${String(hour).padStart(2,"0")}:00:00+00:00`;
const line=(code:string,transaction_code:string,store_id=store.id)=>({store_id,transaction_code,line_number:0,item_code:code,item_name:"Meal",quantity:1,returned_quantity:0});
beforeEach(()=>{
  vi.resetAllMocks();mocks.db.from.mockImplementation(query);
  mocks.catalog.mockResolvedValue({categories:[],bases:[],items:[{id:"BEEF",name:"Beef",baseUom:"g",purchaseUnitName:"pack",purchaseConversion:9999}],products:[{id:"MEAL",name:"Meal",type:"menu",baseUom:"porsi",yieldQuantity:2,ingredients:[{kind:"item",ingredientId:"BEEF",quantity:500,uom:"g"}]}]});
  tables={
    stores:[{id:store.id,active:true}],
    cogs_pos_mappings:[{store_id:store.id,item_code:"POS",product_id:"MEAL",output_quantity:1,output_uom:"porsi"}],
    cogs_count_mappings:[{store_id:store.id,field_key:"beef-shortplate",item_id:"BEEF",conversion:500,base_uom:"g"}],
    stock_opnames:[{id:"OPEN",store_id:store.id,count_date:"2026-10-23",counted_at:stamp(23),counted_by:"Raka"},{id:"CLOSE",store_id:store.id,count_date:"2026-10-24",counted_at:stamp(24),counted_by:"Raka"},{id:"OTHER-COUNT",store_id:"STORE-B",count_date:"2026-10-24",counted_at:stamp(24,14),counted_by:"Raka"}],
    stock_opname_lines:[{stock_opname_id:"OPEN",section:"inventory",field_key:"beef-shortplate",item_id:"BEEF",quantity:3,uom:"Pack"},{stock_opname_id:"CLOSE",section:"inventory",field_key:"beef-shortplate",item_id:"BEEF",quantity:2,uom:"Pack"}],
    pos_transactions:[{store_id:store.id,transaction_code:"AT-OPEN",occurred_at:stamp(23)},{store_id:store.id,transaction_code:"IN",occurred_at:stamp(23,13)},{store_id:store.id,transaction_code:"AT-CLOSE",occurred_at:stamp(24)},{store_id:store.id,transaction_code:"AFTER",occurred_at:stamp(24,13)},{store_id:"STORE-B",transaction_code:"IN",occurred_at:stamp(24)}],
    pos_transaction_items:[line("POS","AT-OPEN"),line("POS","IN"),line("POS","AT-CLOSE"),line("POS","AFTER"),line("UNMAPPED","IN","STORE-B")],
    receivings:[{id:"R-OPEN",store_id:store.id,received_at:stamp(23)},{id:"R-IN",store_id:store.id,received_at:stamp(23,13)},{id:"R-CLOSE",store_id:store.id,received_at:stamp(24)},{id:"R-AFTER",store_id:store.id,received_at:stamp(24,13)},{id:"R-OTHER",store_id:"STORE-B",received_at:stamp(24)}],
    receiving_lines:[...['R-OPEN','R-IN','R-CLOSE','R-AFTER','R-OTHER'].map((receiving_id)=>({receiving_id,line_number:1,item_id:"BEEF",quantity_base:2500,base_uom:"g"}))],
    cogs_sales_coverage:[{store_id:store.id,business_date:"2026-10-23",confirmed_through:stamp(24,13),completed_at:stamp(24,14)},{store_id:store.id,business_date:"2026-10-24",confirmed_through:stamp(24,13),completed_at:stamp(24,14)}],
  };
});
describe("Consumption report loader",()=>{
  it("uses opening-exclusive/closing-inclusive events and isolates stores with repeated POS codes",async()=>{
    const report=await getCogsReport(store,"2026-10-24","2026-10-24");
    expect(report.opening?.id).toBe("OPEN");expect(report.closing?.id).toBe("CLOSE");expect(report.counts.map((count)=>count.id)).toEqual(["CLOSE"]);
    expect(report.rows[0]).toMatchObject({opening:1500,received:5000,closing:1000,actual:5500,theoretical:500,delta:5000});
    expect(report.sales).toHaveLength(1);expect(report.sales[0].quantity).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(/purchasePrice|salesPrice|purchase_price/);
  });
  it("withholds theoretical usage until all covered dates have finished syncing",async()=>{
    tables.cogs_sales_coverage[1].confirmed_through=stamp(24,11);
    const report=await getCogsReport(store,"2026-10-24","2026-10-24");
    expect(report.rows[0]).toMatchObject({actual:5500,theoretical:null,delta:null});expect(report.issues.join()).toContain("2026-10-24");
  });
  it("does not silently drop more than 1000 item lines",async()=>{
    tables.pos_transaction_items=Array.from({length:1005},(_,index)=>({...line("POS","IN"),line_number:index}));
    tables.pos_transaction_items.push(line("POS","AT-CLOSE"));
    const report=await getCogsReport(store,"2026-10-24","2026-10-24");
    expect(report.rows[0].theoretical).toBe(1006*250);
  });
  it("does not silently drop more than 1000 transactions",async()=>{
    tables.pos_transactions=Array.from({length:1002},(_,index)=>({store_id:store.id,transaction_code:`T-${String(index).padStart(5,"0")}`,occurred_at:stamp(24,11)}));
    tables.pos_transaction_items=tables.pos_transactions.map((order)=>line("POS",String(order.transaction_code)));
    const report=await getCogsReport(store,"2026-10-24","2026-10-24");expect(report.rows[0].theoretical).toBe(1002*250);
  });
  it("blocks incomplete transaction details and synthetic stable-code fallbacks",async()=>{
    tables.pos_transaction_items=tables.pos_transaction_items.filter((row)=>row.transaction_code!=="IN");
    let report=await getCogsReport(store,"2026-10-24","2026-10-24");expect(report.rows[0].theoretical).toBeNull();expect(report.issues.join()).toContain("no synced item lines");
    tables.pos_transaction_items.push(line("unknown-0","IN"));report=await getCogsReport(store,"2026-10-24","2026-10-24");expect(report.rows[0].theoretical).toBeNull();
  });
  it("uses sales only for setup when a closing count lacks an opening count",async()=>{
    tables.stock_opnames=tables.stock_opnames.filter((row)=>row.id!=="OPEN");
    const report=await getCogsReport(store,"2026-10-24","2026-10-24");expect(report.opening).toBeNull();expect(report.rows[0].actual).toBeNull();expect(report.rows[0].theoretical).toBeNull();
  });
  it("rejects closing counts outside the store/date scope and ambiguous count times",async()=>{
    await expect(getCogsReport(store,"2026-10-24","2026-10-24","OTHER-COUNT")).rejects.toMatchObject({status:400});
    tables.stock_opnames.push({...tables.stock_opnames[1],id:"DUPLICATE"});
    await expect(getCogsReport(store,"2026-10-24","2026-10-24")).rejects.toMatchObject({status:409});
  });
  it("rejects saving a stale mapping unit before a write",async()=>{
    tables.products=[{id:"MEAL",base_uom:"g"}];
    await expect(saveCogsConfig({storeId:store.id,kind:"pos",mapping:{itemCode:"POS",productId:"MEAL",outputQuantity:1,outputUom:"porsi"}})).rejects.toMatchObject({status:409});
  });
});
