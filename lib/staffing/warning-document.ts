import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { severityOptions, type WarningDocumentData } from "./warning-model";
export async function createWarningPdf(doc: WarningDocumentData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(); pdf.setAuthor("Sarkop"); pdf.setTitle(`${doc.number || "Draft SP"} - ${doc.staff_code}`);
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(regular.getCharacterSet());
  const safe = (value: unknown) => [...String(value ?? "").replace(/[–—→]/g, "-").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")].map(c => c === "\n" || supported.has(c.codePointAt(0)!) ? c : "?").join("");
  const logo = await pdf.embedPng(await readFile(join(process.cwd(), "public/logo_sarkop_red.png")));
  const width = 595.28, height = 841.89, margin = 62, right = width - margin, usable = right - margin, leading = 14;
  const black = rgb(.06,.06,.06), red = rgb(.72,.19,.10), muted = rgb(.40,.40,.40);
  let page = pdf.addPage([width,height]), y = height - 124;
  const data = doc.data;
  const level = Math.min(3, Math.max(1, Number(data.level) || 1));
  const title = `SURAT PERINGATAN ${["PERTAMA", "KEDUA", "KETIGA"][level-1]} (SP${level})`;
  function words(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const paragraph of safe(text).split("\n")) {
      let current = "";
      for (const word of paragraph.split(/\s+/)) {
        if (!word) continue;
        if (font.widthOfTextAtSize(current ? current + " " + word : word, size) > maxWidth && current) { lines.push(current); current = ""; }
        let rest = word;
        while (font.widthOfTextAtSize(rest,size) > maxWidth) { let n = rest.length-1; while(n>1 && font.widthOfTextAtSize(rest.slice(0,n),size)>maxWidth)n--; if(current){lines.push(current);current="";}lines.push(rest.slice(0,n));rest=rest.slice(n); }
        current += (current ? " " : "") + rest;
      }
      lines.push(current);
    }
    return lines;
  }
  function header(first: boolean) {
    page.drawImage(logo,{x:right-84,y:height-64,width:84,height:42});
    if (first) {
      const text=safe(title);page.drawText(text,{x:(width-bold.widthOfTextAtSize(text,12))/2,y:height-94,size:12,font:bold,color:black});
      const number=safe(`Nomor: ${doc.number || "diisi setelah diterbitkan"}`);page.drawText(number,{x:(width-regular.widthOfTextAtSize(number,10))/2,y:height-110,size:10,font:regular,color:black});
      y=height-147;
    } else { page.drawText(safe(`${doc.number || "DRAFT"} | ${doc.staff_code} (lanjutan)`),{x:margin,y:height-79,size:9,font:regular,color:muted});y=height-108; }
  }
  function room(required = leading) { if(y-required<66){page=pdf.addPage([width,height]);header(false);} }
  function text(value: string, face: PDFFont=regular, size=10.5, gap=6) {
    for(const line of words(value,face,size,usable)){room();page.drawText(line,{x:margin,y,size,font:face,color:black});y-=leading;}y-=gap;
  }
  function heading(value:string){room(leading*2);text(value,bold,10.5,2);}
  function row(label:string,value:string) {
    const labelWidth=130,lines=words(value || "[belum diisi]",regular,10.5,usable-labelWidth-10);
    room(Math.min(lines.length,3)*leading);
    page.drawText(safe(label),{x:margin,y,size:10.5,font:bold,color:black});
    page.drawText(":",{x:margin+labelWidth,y,size:10.5,font:regular,color:black});
    for(const line of lines){room();page.drawText(line,{x:margin+labelWidth+9,y,size:10.5,font:regular,color:black});y-=leading;}y-=3;
  }
  const date = (value:string) => {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return "[tanggal belum diisi]";
    return new Intl.DateTimeFormat("id-ID",{timeZone:"UTC",weekday:"long",day:"2-digit",month:"long",year:"numeric"}).format(new Date(value+"T00:00:00Z"));
  };
  header(true);
  if(doc.status==="draft")page.drawText("DRAFT - BELUM DITERBITKAN",{x:margin,y:height-128,size:9,font:bold,color:red});
  if(doc.status==="revoked"){
    room();page.drawText("DIBATALKAN - BUKAN SURAT AKTIF",{x:margin,y,size:10,font:bold,color:red});y-=24;
    if(doc.revoked_at)text(`Dibatalkan pada ${new Intl.DateTimeFormat("id-ID",{timeZone:doc.time_zone,day:"2-digit",month:"long",year:"numeric"}).format(new Date(doc.revoked_at))}`,bold);
    text(`Alasan pembatalan: ${doc.revocation_reason || "-"}`);
  }
  row("Perihal",data.subject);text("Yth. Saudara/i",regular,10.5,2);
  row("Nama karyawan",doc.staff_name);row("Kode staf",doc.staff_code);row("Jabatan / unit kerja",data.job_title);row("Store",doc.store_name);y-=10;
  text("Dengan hormat,",regular,10.5,2);
  text(`Berdasarkan hasil pemeriksaan, perusahaan memberikan Surat Peringatan ${["Pertama", "Kedua", "Ketiga"][level-1]} (SP${level}) kepada Saudara/i. Berikut rincian kejadian yang menjadi dasar peringatan dan pembinaan ini:`);
  row("Tanggal kejadian",date(data.incident_date)+(data.incident_time?`, pukul ${data.incident_time} (${doc.time_zone})`:""));row("Tempat kejadian",data.incident_place);row("Kronologi kejadian",data.chronology);y-=7;
  heading("Hasil pemeriksaan");text(data.findings || "[belum diisi]");
  heading("Dasar peringatan");text(data.policy_reference || "[belum diisi]");
  if(data.clarification){heading("Klarifikasi staf");text(data.clarification);}
  heading("Pembinaan dan tindakan perbaikan");
  const actions=data.corrective_actions.split("\n").map(value=>value.trim()).filter(Boolean);
  if(!actions.length)text("[belum diisi]");
  actions.forEach((action,i)=>text(/^\d+[.)]\s/.test(action)?action:`${i+1}. ${action}`,regular,10.5,3));y-=5;
  heading("Tindak lanjut");text(data.consequences || "[belum diisi]");
  if(data.sanction_note){heading("Sanksi tambahan yang dicatat");text(data.sanction_note);}
  const severity=severityOptions.find(item=>item.value===data.severity)||severityOptions[0];
  text(`Bobot pelanggaran: ${severity.label} (${doc.issued_points ?? severity.points} poin). ${doc.points_before===null || doc.points_after===null?"Akumulasi poin dibukukan saat surat diterbitkan.":`Akumulasi saat penerbitan: ${doc.points_before} menjadi ${doc.points_after} poin.`}`,bold);
  text(`Perbaikan dipantau sejak ${date(data.monitoring_start)} sampai ${date(data.monitoring_end)}. Masa pembinaan surat ini tidak menghapus poin akumulatif; perubahan saldo poin dicatat melalui penyesuaian resmi.`);
  const closing="Demikian surat ini disampaikan untuk diperhatikan dan dilaksanakan dengan penuh tanggung jawab.";
  const cityDate=`${data.issue_city || "[kota]"}, ${date(data.letter_date)}`;
  const signatureHeight=8+42+[cityDate,"Hormat kami,",data.signer_role||"[jabatan penerbit]",data.signer_name||"[nama penerbit]"].reduce((sum,value)=>sum+words(value,regular,10.5,usable).length*leading+2,0);
  room(signatureHeight+words(closing,regular,10.5,usable).length*leading+6);
  text(closing);y-=8;
  text(cityDate,regular,10.5,2);
  text("Hormat kami,",regular,10.5,2);text(data.signer_role || "[jabatan penerbit]",regular,10.5,2);y-=42;
  text(data.signer_name || "[nama penerbit]",bold,10.5,1);
  const pages=pdf.getPages();pages.forEach((p,i)=>{
    const footer=safe(`Pribadi${doc.status==="revoked"?" | DIBATALKAN":doc.status==="draft"?" | DRAFT":""} | ${doc.number || "DRAFT"} | ${doc.staff_code} | ${i+1}/${pages.length}`);
    p.drawLine({start:{x:margin,y:44},end:{x:right,y:44},thickness:.4,color:rgb(.82,.82,.82)});
    p.drawText(footer,{x:margin,y:30,size:7.5,font:regular,color:muted});
  });
  return pdf.save();
}
