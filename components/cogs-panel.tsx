"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { addDays } from "@/lib/analytics/dashboard";
import { STOCK_FIELDS } from "@/lib/stock-opname/template";
import type { CogsReport, CountMapping, PosMapping } from "@/lib/cogs/types";
import type { CogsConfigInput } from "@/lib/cogs/config";
import type { DashboardMode } from "@/lib/analytics/types";
import { standardConversion } from "@/lib/items/model";
import styles from "./cogs.module.css";

const qty = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const value = (number: number | null) => number === null ? "—" : qty.format(number);
function editableAmount(quantity: number, from: string, to: string): string {
  if (from === to) return String(quantity);
  if (from === "porsi" || to === "porsi") return "";
  try { const factor=standardConversion(from,to as CountMapping["baseUom"]);return factor===null?"":String(quantity*factor); }
  catch { return ""; }
}
type Setup = CogsReport["setup"];
type Save = (input: Omit<Extract<CogsConfigInput,{kind:"pos"}>,"storeId"> | Omit<Extract<CogsConfigInput,{kind:"count"}>,"storeId"> |
  Omit<Extract<CogsConfigInput,{kind:"delete-pos"}>,"storeId"> | Omit<Extract<CogsConfigInput,{kind:"delete-count"}>,"storeId">) => Promise<void>;

function CountEditor({ field, setup, mapping, save }: { field: typeof STOCK_FIELDS[number]; setup: Setup; mapping?: CountMapping; save: Save }) {
  const match = setup.items.filter((item) => field.aliases.some((alias) => alias.toLowerCase() === item.name.toLowerCase()));
  const [itemId,setItemId]=useState(mapping?.itemId || (match.length===1 ? match[0].id : ""));
  const [conversion,setConversion]=useState(mapping ? editableAmount(mapping.conversion,mapping.baseUom,setup.items.find((item)=>item.id===mapping.itemId)?.baseUom||mapping.baseUom) : "");
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const item=setup.items.find((item)=>item.id===itemId);
  async function submit(remove=false) {
    if(!item && !remove) return;
    setBusy(true);setError("");
    try { await save(remove ? {kind:"delete-count",fieldKey:field.key} : {kind:"count",mapping:{fieldKey:field.key,itemId,conversion:Number(conversion),baseUom:item!.baseUom}}); }
    catch(error) {setError(error instanceof Error?error.message:"Could not save");} finally {setBusy(false);}
  }
  return <div className={styles.editorRow}><div className={styles.rowName}>{field.name}<small>Counted in {field.uom}{!mapping && " · not configured"}</small></div>
    <label><span className="sr-only">Raw material for {field.name}</span><select value={itemId} onChange={(event)=>{setItemId(event.target.value);setConversion("");}} disabled={busy}><option value="">Choose raw material</option>{setup.items.map((item)=><option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
    <label className={styles.conversion}>1 {field.uom} = <input type="number" min="0.000000001" max="1000000000000" step="any" placeholder="Size" value={conversion} onChange={(event)=>setConversion(event.target.value)} disabled={busy||!item} aria-label={`Base quantity in one ${field.uom} of ${field.name}`} /><span>{item?.baseUom||"base units"}</span></label>
    <div className={styles.rowActions}><button type="button" disabled={busy||!item||!conversion||Number(conversion)<=0} onClick={()=>void submit()}>{busy?"Saving…":"Save"}</button>{mapping&&<button type="button" className={styles.remove} disabled={busy} onClick={()=>void submit(true)}>Unlink</button>}</div>
    {item&&<small className={styles.rowHint}>Item reference: 1 {item.purchaseUnitName} = {value(item.purchaseConversion)} {item.baseUom}. Confirm the size of the stock-count unit; it may differ.</small>}
    {error&&<p className={styles.rowError} role="alert">{error}</p>}
  </div>;
}
function PosEditor({ code,names,quantity,setup,mapping,save }: {code:string;names:string[];quantity:number|null;setup:Setup;mapping?:PosMapping;save:Save}) {
  const [productId,setProductId]=useState(mapping?.productId||"");
  const [output,setOutput]=useState(mapping?editableAmount(mapping.outputQuantity,mapping.outputUom,setup.products.find((product)=>product.id===mapping.productId)?.baseUom||mapping.outputUom):"1");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const product=setup.products.find((product)=>product.id===productId);
  async function submit(remove=false) {
    if(!product&&!remove)return;
    setBusy(true);setError("");
    try{await save(remove?{kind:"delete-pos",itemCode:code}:{kind:"pos",mapping:{itemCode:code,productId,outputQuantity:Number(output),outputUom:product!.baseUom}});}
    catch(error){setError(error instanceof Error?error.message:"Could not save");}finally{setBusy(false);}
  }
  return <div className={styles.editorRow}><div className={styles.rowName}>{names.join(" / ")||code}<small>{code}{quantity!==null?` · ${value(quantity)} net sold`:""}{!mapping&&" · not linked"}</small></div>
    <label><span className="sr-only">Catalogue product for POS code {code}</span><select value={productId} onChange={(event)=>{setProductId(event.target.value);setOutput("1");}} disabled={busy}><option value="">Choose product / variant / add-on</option>{setup.products.map((product)=><option value={product.id} key={product.id}>{product.name} · {product.type} · {product.id}</option>)}</select></label>
    <label className={styles.conversion}>1 POS unit = <input type="number" min="0.000000001" max="1000000000000" step="any" value={output} onChange={(event)=>setOutput(event.target.value)} disabled={busy||!product} aria-label={`Output quantity per POS unit for ${code}`} /><span>{product?.baseUom||"output units"}</span></label>
    <div className={styles.rowActions}><button type="button" disabled={busy||!product||!output||Number(output)<=0||/^unknown-\d+$/.test(code)} onClick={()=>void submit()}>{busy?"Saving…":"Save"}</button>{mapping&&<button className={styles.remove} type="button" disabled={busy} onClick={()=>void submit(true)}>Unlink</button>}</div>
    {names.length>1&&<small className={styles.rowHint}>This code has multiple POS names. Confirm they all use the same recipe; distinct variants need distinct POS codes.</small>}
    {error&&<p className={styles.rowError} role="alert">{error}</p>}
  </div>;
}
function SetupPanel({report,save}:{report:CogsReport;save:Save}) {
  const [tab,setTab]=useState<"pos"|"counts">("pos"),[search,setSearch]=useState(""),[manual,setManual]=useState("");
  const mappings=new Map(report.setup.posMappings.map((mapping)=>[mapping.itemCode,mapping]));
  const sales=new Map(report.sales.map((sale)=>[sale.itemCode,sale]));
  const codes=[...new Set([...sales.keys(),...mappings.keys(),...(manual?[manual]:[])])].sort((a,b)=>Number(Boolean(mappings.get(a)))-Number(Boolean(mappings.get(b)))||a.localeCompare(b));
  return <details className={styles.setup}><summary>Set up POS links & count units <span>{report.setup.posMappings.length} POS links · {report.setup.countMappings.length}/22 count definitions</span></summary>
    <div className={styles.setupBody}><div className={styles.setupTabs}><button type="button" aria-pressed={tab==="pos"} onClick={()=>{setTab("pos");setSearch("");}}>POS → Products</button><button type="button" aria-pressed={tab==="counts"} onClick={()=>{setTab("counts");setSearch("");}}>Count units → Raw materials</button></div>
      <p>{tab==="pos"?"Link each Kasirpintar code to its full catalogue recipe. A variant uses its own recipe. Separately sold add-ons need their own links. One POS unit usually means one portion or piece—confirm it below.":"For each of the 22 inventory lines, choose the raw material and define how much one Pack, Tray, Karung or Botol contains. These definitions are specific to this store."}</p>
      <div className={styles.setupTools}><input type="search" value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Search names or IDs" aria-label="Search consumption setup" />{tab==="pos"&&<label>Enter another POS code <input value={manual} maxLength={200} onChange={(event)=>setManual(event.target.value)} placeholder="Exact Kasirpintar code" /></label>}</div>
      {tab==="pos"?<><p className={styles.note}><Link href="/products">Create missing products and recipes</Link> first. Names are shown for reference; matching is by store + POS code.</p>{!codes.length&&<p>No POS items in this period yet. Enter a code above or select a date with synced sales.</p>}{codes.filter((code)=>`${code} ${sales.get(code)?.names.join(" ")||""}`.toLowerCase().includes(search.toLowerCase())).map((code)=><PosEditor key={`${code}-${JSON.stringify(mappings.get(code))}`} code={code} names={sales.get(code)?.names||[]} quantity={sales.get(code)?.quantity??null} setup={report.setup} mapping={mappings.get(code)} save={save}/>)}</>:
        STOCK_FIELDS.filter((field)=>field.section==="inventory"&&field.name.toLowerCase().includes(search.toLowerCase())).map((field)=>{const mapping=report.setup.countMappings.find((mapping)=>mapping.fieldKey===field.key);return <CountEditor key={`${field.key}-${JSON.stringify(mapping)}`} field={field} setup={report.setup} mapping={mapping} save={save}/>;})}
      <p className={styles.note}>MVP uses current recipes and count-unit definitions, including for past intervals. Editing them recalculates past reports. Raw stock counts and receiving records stay unchanged.</p>
    </div>
  </details>;
}

export function CogsPanel({storeId,mode,date,today,timeZone,refreshKey}:{storeId:string;mode:DashboardMode;date:string;today:string;timeZone:string;refreshKey:number}) {
  const start=mode==="monthly"?`${date.slice(0,7)}-01`:date;
  const end=mode==="monthly"?(()=>{const next=new Date(`${start}T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);const last=addDays(next.toISOString().slice(0,10),-1);return last<today?last:today;})():date;
  // Calendar filters choose possible closing counts; the calculation always labels its exact count interval.
  const [report,setReport]=useState<CogsReport|null>(null),[error,setError]=useState("");
  const [closing,setClosing]=useState(""),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true);
  const [saved,setSaved]=useState("");
  const scope=`${storeId}|${start}|${end}|${closing}`;
  const [loadedScope,setLoadedScope]=useState("");
  const current=loadedScope===scope?report:null;
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    async function load(){
      setLoading(true);setError("");
      try{
        const params=new URLSearchParams({store:storeId,start,end,...(closing?{closing}:{})});
        const response=await fetch(`/api/cogs?${params}`,{cache:"no-store",signal:controller.signal});
        const body=await response.json();if(!response.ok)throw new Error(body.error||"Could not load consumption");
        if(active){setReport(body);setLoadedScope(scope);}
      }catch(error){if(active)setError(error instanceof Error?error.message:"Could not load consumption");}
      finally{if(active)setLoading(false);}
    }
    void load();
    return()=>{active=false;controller.abort();};
  },[storeId,start,end,closing,revision,refreshKey,scope]);
  // Only completed counts change actual usage. Refresh once a minute, separately from the 3s sales feed.
  useEffect(()=>{const timer=window.setInterval(()=>setRevision((revision)=>revision+1),60000);return()=>clearInterval(timer);},[]);
  const summary=useMemo(()=>current?{ready:current.rows.filter((row)=>row.delta!==null).length,missing:current.sales.filter((sale)=>sale.issue).length}:null,[current]);
  async function save(input:Parameters<Save>[0]){
    const response=await fetch("/api/cogs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,storeId})});
    const body=await response.json();if(!response.ok)throw new Error(body.error||"Could not save link");
    setSaved("Setup saved.");setRevision((revision)=>revision+1);
  }
  const time=(stamp:string|null)=>stamp?new Intl.DateTimeFormat("en-GB",{timeZone,dateStyle:"medium",timeStyle:"short"}).format(new Date(stamp)):"Count time missing";
  return <section className={styles.panel} aria-labelledby="consumption-heading" aria-busy={loading}><div className={styles.heading}><div><h2 id="consumption-heading">Consumption variance <span>Quantity only</span></h2><p>Actual usage − theoretical usage · 22 raw materials</p></div><button type="button" disabled={loading} onClick={()=>setRevision((revision)=>revision+1)}>{loading?"Loading…":"Refresh"}</button></div>
    {error&&<p className={styles.error} role="alert">{error}</p>}{saved&&<p className={styles.saved} role="status">{saved}</p>}
    {!current&&!error&&<p className={styles.empty}>Loading stock counts, receiving and recipe links…</p>}
    {current&&<><div className={styles.interval}><label>Closing stock count <select value={closing||current.closing?.id||""} onChange={(event)=>setClosing(event.target.value)}><option value="">Latest timed count in selected period</option>{current.counts.map((count)=><option key={count.id} value={count.id} disabled={!count.countedAt}>{time(count.countedAt)} · {count.countedBy}</option>)}</select></label><div><small>Compared with previous count</small><strong>{time(current.opening?.countedAt||null)} → {current.closing?time(current.closing.countedAt):"Awaiting closing count"}</strong><span>One completed count interval, not a calendar {mode==="monthly"?"month":"day"} total. Times: {timeZone}.</span></div></div>
      <div className={styles.status}><span><i className={current.complete?styles.ready:styles.pending}/>{summary?.ready}/22 materials ready</span><span>{summary?.missing||0} POS codes need attention</span><span>{current.setup.countMappings.length}/22 count units configured</span></div>
      {!current.opening||!current.closing?<p className={styles.notice}>Submit two <Link href="/stock-opname">stock counts</Link> with their physical count times for this store. Record deliveries in <Link href="/receiving">Receiving</Link> between counts. Missing values stay blank; they are never treated as zero.</p>:null}
      {current.issues.length>0&&<details className={styles.blockers}><summary>{current.issues.length} issue{current.issues.length===1?"":"s"} preventing a complete comparison</summary><ul>{current.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></details>}
      <div className={styles.tableWrap}><table><thead><tr><th>Raw material</th><th>Unit</th><th>Opening</th><th>Received</th><th>Closing</th><th>Actual used</th><th>Theoretical</th><th>Difference</th></tr></thead><tbody>{current.rows.map((row)=><tr key={row.key}><th scope="row">{row.name}{row.issues.length>0&&<small title={row.issues.join(". ")}>{row.issues.join(" · ")}</small>}</th><td>{row.uom||"—"}</td><td>{value(row.opening)}</td><td>{value(row.received)}</td><td>{value(row.closing)}</td><td className={styles.emphasis}>{value(row.actual)}</td><td>{value(row.theoretical)}</td><td className={`${styles.emphasis} ${row.delta!==null&&row.delta>0?styles.excess:""}`}>{row.delta!==null&&row.delta>0?"+":""}{value(row.delta)}</td></tr>)}</tbody></table></div>
      <p className={styles.note}>Opening + received − closing = actual used. Positive difference means more raw material used than recipes predict. Prepared stock is excluded from inventory: ingredients moved into unsold bases can also increase this difference. Returns reduce theoretical usage; refunds do not prove ingredients returned to stock. No 5% cost allowance is added.</p>
      <SetupPanel report={current} save={save}/>
    </>}
  </section>;
}
