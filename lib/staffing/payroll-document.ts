import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { PayrollResult } from "./operations-model";
export type PayrollDocumentData = {
  id: string; staff_name: string; staff_code: string; store_name: string; time_zone: string;
  period_start: string; period_end: string; created_at: string; result: PayrollResult; final: boolean;
};
export async function createPayrollPdf(data: PayrollDocumentData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(); pdf.setTitle(`Slip payroll ${data.staff_code} ${data.period_start}`); pdf.setAuthor("Spark Intelligence");
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(font.getCharacterSet());
  const safe = (value: string) => [...value.replace(/[–—→]/g, "-").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")].map(c => supported.has(c.codePointAt(0)!) ? c : "?").join("");
  const width = 595.28, height = 841.89, margin = 44, right = width - margin;
  let page = pdf.addPage([width, height]), y = height - 52;
  const ink = rgb(.09,.16,.13), green = rgb(.09,.31,.24), muted = rgb(.38,.44,.40);
  function room() { if (y < 78) { page = pdf.addPage([width,height]); y = height - 52; } }
  function line(text: string, size = 10, face: PDFFont = font, color = ink) {
    if (y < 78) { page = pdf.addPage([width,height]); y = height - 52; }
    const draw = (value: string) => { room(); page.drawText(value,{x:margin,y,size,font:face,color}); y -= size + 6; };
    const words = safe(text).split(/\s+/); let current = "";
    for (const word of words) {
      if (face.widthOfTextAtSize(current ? current + " " + word : word,size) > right - margin && current) { draw(current); current = ""; }
      // Hard-wrap long unbroken identifiers or names.
      let rest = word;
      while (face.widthOfTextAtSize(rest,size) > right-margin) { let n=rest.length-1; while(n>1&&face.widthOfTextAtSize(rest.slice(0,n),size)>right-margin)n--; if(current){draw(current);current="";}draw(rest.slice(0,n));rest=rest.slice(n); }
      current += (current ? " " : "") + rest;
    }
    if (current) { draw(current); }
  }
  const money = (amount: number) => "Rp " + new Intl.NumberFormat("id-ID",{maximumFractionDigits:0}).format(amount);
  line("SPARK INTELLIGENCE",10,bold,green); y-=6;
  line(data.final ? "SLIP PAYROLL FINAL" : "DRAFT - BELUM FINAL",21,bold,data.final?green:rgb(.68,.30,.10)); y-=10;
  line(data.staff_name,16,bold); line(`Kode staf: ${data.staff_code}`); line(`Store: ${data.store_name} | ${data.time_zone}`);
  const date = (value:string) => value.split("-").reverse().join("/");
  line(`Periode: ${date(data.period_start)} - ${date(data.period_end)}`); y-=14;
  const rows:[string,number][] = [["Upah normal",data.result.normal_pay],["Upah malam",data.result.night_pay],["Lembur",data.result.overtime_pay],["Izin berbayar",data.result.paid_leave_pay],["Sakit berbayar",data.result.sick_pay],["Bonus / THR",data.result.bonuses],["Total bruto",data.result.gross_pay],["Penalti durasi",data.result.late_penalties],["Penalti frekuensi",data.result.frequency_penalty],["Total potongan",data.result.deductions],["Pengembalian kasbon",data.result.loan_repayment],["GAJI BERSIH",data.result.net_pay]];
  for (const [label,amount] of rows) {
    room();
    const total = ["Total bruto","Total potongan","GAJI BERSIH"].includes(label), face = total ? bold : font;
    if (total) { page.drawLine({start:{x:margin,y:y+8},end:{x:right,y:y+8},thickness:.6,color:rgb(.82,.85,.81)});y-=3; }
    const text = money(amount); page.drawText(label,{x:margin,y,size:11,font:face,color:ink});page.drawText(text,{x:right-face.widthOfTextAtSize(text,11),y,size:11,font:face,color:label==="GAJI BERSIH"?green:ink}); y-=total?30:25;
  }
  y-=8; line(`Normal ${data.result.normal_hours.toFixed(2)} jam | Malam ${data.result.night_hours.toFixed(2)} jam | Lembur ${data.result.overtime_hours.toFixed(2)} jam`,9,font,muted);
  if (!data.final) for (const blocker of data.result.blockers) line("Belum final: " + blocker,9,font,rgb(.65,.25,.12));
  line(data.final ? "Hasil perhitungan final tersimpan. Dokumen ini bukan bukti transfer pembayaran." : "Pratinjau dapat berubah. Dokumen draft tidak dikirim ke staf sebagai slip final.",9,font,muted);
  line("Referensi: " + data.id,8,font,muted);
  const pages = pdf.getPages(); pages.forEach((p,i)=>p.drawText(`Pribadi - hanya untuk staf terkait dan manager | ${i+1}/${pages.length}`,{x:margin,y:32,size:8,font,color:muted}));
  return pdf.save();
}
