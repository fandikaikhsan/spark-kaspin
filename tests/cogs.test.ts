import { describe, expect, it } from "vitest";
import { calculateConsumption, expandProduct, type CogsInput } from "@/lib/cogs/engine";
import { parseCogsConfig } from "@/lib/cogs/config";
import type { CogsBase, CogsCount, CogsItem, CogsProduct } from "@/lib/cogs/types";
import { parseStockOpname } from "@/lib/stock-opname/model";
import { COUNTERS, STOCK_FIELDS } from "@/lib/stock-opname/template";

const item: CogsItem={id:"BEEF",name:"Beef",baseUom:"g",purchaseUnitName:"pack",purchaseConversion:500};
const base: CogsBase={id:"PREP",name:"Beef base",baseUom:"porsi",yieldQuantity:10,ingredients:[{itemId:"BEEF",quantity:1,uom:"kg"}]};
const product: CogsProduct={id:"MEAL",name:"Meal",type:"menu",baseUom:"porsi",yieldQuantity:2,ingredients:[{kind:"base",ingredientId:"PREP",quantity:4,uom:"porsi"},{kind:"item",ingredientId:"BEEF",quantity:100,uom:"g"}]};
const count=(id:string,day:string,quantity:number):CogsCount=>({id,date:day,countedAt:`${day}T12:00:00Z`,countedBy:"Raka",lines:[{key:"beef-shortplate",itemId:"BEEF",quantity,uom:"Pack"}]});
const input=():CogsInput=>({items:[item],bases:[base],products:[product],posMappings:[{itemCode:"POS-1",productId:"MEAL",outputQuantity:1,outputUom:"porsi"}],countMappings:[{fieldKey:"beef-shortplate",itemId:"BEEF",conversion:500,baseUom:"g"}],opening:count("OPEN","2026-10-23",3),closing:count("CLOSE","2026-10-24",2),sales:[{itemCode:"POS-1",itemName:"Meal",quantity:10,returnedQuantity:2}],receipts:[{itemId:"BEEF",quantityBase:5000,baseUom:"g"}]});
const beef=(value:CogsInput)=>calculateConsumption(value).rows.find((row)=>row.key==="beef-shortplate")!;

describe("Quantity consumption engine",()=>{
  it("explodes base and product batch yields with no 5% monetary overhead",()=>{
    // (4 portions × 100g + 100g) / 2 product portions = 250g each.
    expect(expandProduct(product,[item],[base]).get("BEEF")).toBe(250);
    expect(beef(input())).toMatchObject({opening:1500,received:5000,closing:1000,actual:5500,theoretical:2000,delta:3500,uom:"g"});
  });
  it("retains exactly 22 inventory rows and excludes prep and restock",()=>{
    const report=calculateConsumption(input());
    expect(report.rows).toHaveLength(22);
    expect(report.rows.map((row)=>row.key)).not.toContain("prep-ayam-suwir");
    expect(report.rows.map((row)=>row.key)).not.toContain("bawang-merah");
    expect(report.complete).toBe(false); // Only beef has a count definition in this fixture.
  });
  it("supports a resale product consuming one purchased item, including fractional sales",()=>{
    const raw={...item,baseUom:"pcs" as const,purchaseConversion:12};
    const water={...product,ingredients:[{kind:"item" as const,ingredientId:"BEEF",quantity:1,uom:"pcs"}],yieldQuantity:1};
    const data=input(); data.items=[raw];data.products=[water];data.countMappings[0]={...data.countMappings[0],conversion:12,baseUom:"pcs"};data.sales[0].quantity=2.5;data.sales[0].returnedQuantity=0;data.receipts=[];
    expect(beef(data)).toMatchObject({actual:12,theoretical:2.5,delta:9.5});
  });
  it("uses a variant's own full recipe and a separately sold add-on exactly once",()=>{
    const variant={...product,id:"VARIANT",type:"variant" as const,ingredients:[{kind:"item" as const,ingredientId:"BEEF",quantity:1,uom:"pack"}],yieldQuantity:1};
    const addon={...product,id:"ADDON",type:"addon" as const,ingredients:[{kind:"item" as const,ingredientId:"BEEF",quantity:25,uom:"g"}],yieldQuantity:1};
    const data=input();data.products.push(variant,addon);data.posMappings=[{itemCode:"V",productId:variant.id,outputQuantity:1,outputUom:"porsi"},{itemCode:"A",productId:addon.id,outputQuantity:1,outputUom:"porsi"}];data.sales=[{itemCode:"V",itemName:"Variant",quantity:2,returnedQuantity:0},{itemCode:"A",itemName:"Addon",quantity:2,returnedQuantity:0}];
    expect(beef(data).theoretical).toBe(1050);
  });
  it("honors output amount per POS unit and compatible saved base units",()=>{
    const data=input();data.products=[{...product,baseUom:"g",yieldQuantity:1000,ingredients:[{kind:"item",ingredientId:"BEEF",quantity:1,uom:"kg"}]}];
    data.posMappings[0]={...data.posMappings[0],outputQuantity:0.25,outputUom:"kg"};data.countMappings[0]={...data.countMappings[0],conversion:0.5,baseUom:"kg"};data.receipts=[{itemId:"BEEF",quantityBase:5,baseUom:"kg"}];
    expect(beef(data)).toMatchObject({actual:5500,theoretical:2000,delta:3500});
  });
  it("withholds every theoretical amount and delta when any positive sale is unmapped",()=>{
    const data=input();data.sales.push({itemCode:"MISSING",itemName:"Unknown",quantity:1,returnedQuantity:0});
    expect(beef(data)).toMatchObject({actual:5500,theoretical:null,delta:null});
    expect(calculateConsumption(data).issues.join()).toContain("MISSING");
  });
  it("does not demand recipes for fully returned sales, but rejects impossible returns",()=>{
    const data=input();data.sales.push({itemCode:"MISSING",itemName:"Refunded",quantity:1,returnedQuantity:1});
    expect(beef(data).theoretical).toBe(2000);
    data.sales[1].returnedQuantity=2;expect(beef(data).theoretical).toBeNull();
  });
  it("never invents a zero for missing counts, units, or sync coverage",()=>{
    const data=input();data.opening=null;expect(beef(data)).toMatchObject({actual:null,theoretical:null,delta:null});
    data.opening=count("OPEN","2026-10-23",3);data.countMappings=[];expect(beef(data).actual).toBeNull();
    data.countMappings=input().countMappings;data.salesIssues=["Sales not fully synced"];expect(beef(data)).toMatchObject({actual:5500,theoretical:null,delta:null});
    data.salesIssues=[];data.opening.countedAt=null;expect(beef(data).actual).toBeNull();
  });
  it("allows true zero theoretical usage only with a complete empty sales interval",()=>{
    const data=input();data.sales=[];expect(beef(data)).toMatchObject({theoretical:0,delta:5500});
  });
  it("flags stock gains, missing receiving, changed item links, and invalid units",()=>{
    const data=input();data.receipts=[];data.closing!.lines[0].quantity=5;
    expect(beef(data)).toMatchObject({actual:-1000,delta:null});expect(beef(data).issues.join()).toContain("Stock increased");
    data.closing!.lines[0].itemId="OTHER";expect(beef(data).actual).toBeNull();
    data.closing!.lines[0].itemId="BEEF";data.countMappings[0].baseUom="ml";expect(beef(data).actual).toBeNull();
  });
  it("blocks mismatched portion/mass recipes and unknown ingredient conversions",()=>{
    const data=input();data.products[0]={...product,ingredients:[{kind:"base",ingredientId:"PREP",quantity:1,uom:"g"}]};
    expect(beef(data).theoretical).toBeNull();
    expect(()=>expandProduct({...product,ingredients:[{kind:"item",ingredientId:"BEEF",quantity:1,uom:"drop"}]},[item],[base])).toThrow();
    expect(()=>expandProduct({...product,yieldQuantity:0},[item],[base])).toThrow();
  });
  it("rejects synthetic POS codes and duplicate raw-material count links",()=>{
    const data=input();data.sales[0].itemCode="unknown-1";expect(beef(data).theoretical).toBeNull();
    data.countMappings.push({...data.countMappings[0],fieldKey:"sosis"});expect(beef(data).actual).toBeNull();
  });
  it("can produce a complete report when all 22 definitions and counts exist",()=>{
    const data=input();const fields=STOCK_FIELDS.filter((field)=>field.section==="inventory");
    data.items=fields.map((field)=>({...item,id:field.key}));data.countMappings=fields.map((field)=>({fieldKey:field.key,itemId:field.key,conversion:1,baseUom:"g"}));
    data.sales=[];data.receipts=[];
    for(const count of [data.opening!,data.closing!])count.lines=fields.map((field)=>({key:field.key,itemId:field.key,quantity:0,uom:field.uom!}));
    expect(calculateConsumption(data).complete).toBe(true);
    expect(calculateConsumption(data).rows.every((row)=>row.delta===0)).toBe(true);
  });
});

describe("Consumption setup and count time validation",()=>{
  const storeId="00000000-0000-4000-8000-000000000001";
  it("validates explicit POS links and count-unit sizes",()=>{
    expect(parseCogsConfig({storeId,kind:"pos",mapping:{itemCode:"1234",productId:"MEAL",outputQuantity:1,outputUom:"porsi"}}).kind).toBe("pos");
    for(const conversion of [0,-1,"500",NaN,Infinity])expect(()=>parseCogsConfig({storeId,kind:"count",mapping:{fieldKey:"beef-shortplate",itemId:"BEEF",conversion,baseUom:"g"}})).toThrow();
    for(const fieldKey of ["bawang-merah","prep-ayam-suwir","unknown"])expect(()=>parseCogsConfig({storeId,kind:"delete-count",fieldKey})).toThrow();
    expect(()=>parseCogsConfig({storeId,kind:"delete-pos",itemCode:"unknown-0"})).toThrow();
  });
  it("preserves an explicit count time; legacy date-only counts cannot enable the engine",()=>{
    const raw={id:storeId,storeId,countDate:"2026-10-24",countedAt:"2026-10-24T19:30:00+08:00",countedBy:COUNTERS[0],answers:Object.fromEntries(STOCK_FIELDS.map((field)=>[field.key,field.section==="restock"?false:0]))};
    expect(parseStockOpname(raw).countedAt).toBe(raw.countedAt);
    expect(()=>parseStockOpname({...raw,countedAt:"2026-10-24"})).toThrow();
  });
});
