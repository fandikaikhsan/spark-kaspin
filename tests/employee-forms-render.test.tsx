import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StockOpnamePage } from "@/components/stock-opname";
import { ReceivingPage } from "@/components/receiving";
import type { Store } from "@/lib/stores";
const stores:Store[]=[{id:"00000000-0000-4000-8000-000000000001",name:"Sarkop Palu",timeZone:"Asia/Makassar",utcOffset:"+08:00",active:true,isDefault:true}];
describe("Standalone employee forms",()=>{
  it("renders a stock form without navigation/history/manual time, with a progress bar and final Selesai",()=>{
    const html=renderToStaticMarkup(<StockOpnamePage employeeMode stores={stores} initialSubmissions={[]} initialError={null} initialDate="2026-10-24"/>);
    expect(html).toContain('role="progressbar"');expect(html).toContain('aria-valuemax="40"');
    expect(html).toContain("Untuk menentukan jumlah prep besok.");expect(html).toContain("Hitung dan isi sesuai satuan.");
    expect(html).toContain(">Selesai</button>");
    for(const text of ['<nav','href=','<img','role="tab"','type="time"','type="date"','0 / 40','Riwayat','Operasional toko'])expect(html).not.toContain(text);
    expect(html.indexOf(">Selesai</button>")).toBeGreaterThan(html.indexOf('Kemiri'));
  });
  it("renders receiving with item/quantity/unit controls but no links, history or prices",()=>{
    const html=renderToStaticMarkup(<ReceivingPage employeeMode stores={stores} items={[{id:"BEEF",name:"Beef",baseUom:"g",purchaseUnitName:"pack",updatedAt:"2026-10-24T00:00:00Z"}]} initialReceivings={[]} initialError={null}/>);
    expect(html).toContain('role="combobox"');expect(html).toContain('Satuan barang 1');expect(html).toContain("Tambah barang");expect(html).toContain(">Selesai</button>");
    for(const text of ['<nav','href=','<img','role="tab"','Riwayat','purchasePrice','salesPrice','Operasional toko'])expect(html).not.toContain(text);
  });
});
