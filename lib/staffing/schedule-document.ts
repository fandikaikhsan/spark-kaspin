import{PDFDocument,StandardFonts,rgb,type PDFFont}from"pdf-lib";
import{fragments,clippedMinutes,hoursLabel,type ScheduleWeek,type PlanShift,addDays}from"./schedule";
export function committedRows(data:ScheduleWeek){
 const map=new Map<string,{id:string;name:string;code:string;days:string[][];minutes:number}>();
 const shifts:PlanShift[]=data.shifts.map(s=>({...s,persisted:true}));
 for(const s of data.shifts){if(!map.has(s.staff_id))map.set(s.staff_id,{id:s.staff_id,name:s.full_name,code:data.staff.find(st=>st.id===s.staff_id)?.code||s.staff_id.slice(0,8),days:Array.from({length:7},()=>[]),minutes:0});map.get(s.staff_id)!.minutes+=clippedMinutes(s,data.week_start,data.store.time_zone);}
 const clock=(minute:number)=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(Math.floor(minute%60)).padStart(2,'0')}`;
 for(const p of fragments(shifts,data.week_start,data.store.time_zone).sort((a,b)=>a.day-b.day||a.start-b.start)){const row=map.get(p.shift.staff_id)!;row.days[p.day].push(`${clock(p.start)} - ${clock(p.end)}${p.continues?' (+)':''}`,p.shift.label);}
 return[...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function wrap(text:string,font:PDFFont,size:number,width:number):string[]{
 const output:string[]=[];let line='';for(const word of text.split(/\s+/)){let candidate=line?line+' '+word:word;if(font.widthOfTextAtSize(candidate,size)<=width){line=candidate;continue;}if(line){output.push(line);line='';}candidate=word;while(candidate&&font.widthOfTextAtSize(candidate,size)>width){let cut=candidate.length-1;while(cut>1&&font.widthOfTextAtSize(candidate.slice(0,cut),size)>width)cut--;output.push(candidate.slice(0,cut));candidate=candidate.slice(cut);}line=candidate;}if(line)output.push(line);return output.length?output:[''];
}
export async function createSchedulePdf(data:ScheduleWeek):Promise<Uint8Array>{
 const pdf=await PDFDocument.create();pdf.setTitle(`Jadwal ${data.store.name} ${data.week_start}`);pdf.setAuthor('Spark Intelligence');
 const regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);const supported=new Set(regular.getCharacterSet());let replaced=false;
 const safe=(v:string)=>[...v.replace(/[–—]/g,'-').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')].map(c=>supported.has(c.codePointAt(0)!)?c:(replaced=true,'?')).join('');
 const green=rgb(.09,.31,.24),ink=rgb(.1,.14,.12),muted=rgb(.4,.46,.42),line=rgb(.85,.86,.82),pale=rgb(.93,.96,.93);
 const width=841.89,height=595.28,margin=28,colWidths=[150,...Array(7).fill((width-margin*2-205)/7),55];let page=pdf.addPage([width,height]),y=0;
 const days=['Sen','Sel','Rab','Kam','Jum','Sab','Min'];
 function header(){page.drawText('SPARK INTELLIGENCE / STAFFING',{x:margin,y:height-30,size:8,font:bold,color:green});page.drawText(safe(data.store.name),{x:margin,y:height-54,size:19,font:bold,color:ink});page.drawText(`${data.week_start} - ${addDays(data.week_start,6)} | ${data.store.time_zone} | Jadwal ter-commit`,{x:margin,y:height-72,size:9,font:regular,color:muted});y=height-91;let x=margin;['STAFF',...days.map((d,i)=>`${d} ${addDays(data.week_start,i).slice(8)}`),'JAM'].forEach((label,i)=>{page.drawRectangle({x,y:y-26,width:colWidths[i],height:26,color:green});page.drawText(label,{x:x+7,y:y-17,size:8,font:bold,color:rgb(1,1,1)});x+=colWidths[i];});y-=26;}
 header();const rows=committedRows(data);let stripe=0;
 for(const row of rows){const cells=[wrap(safe(row.name),bold,8,colWidths[0]-14).concat(safe(row.code)),...row.days.map((values,i)=>values.length?values.flatMap(v=>wrap(safe(v),regular,7.4,colWidths[i+1]-12)):['-']),[hoursLabel(row.minutes)]];const total=Math.max(...cells.map(c=>c.length));for(let offset=0;offset<total;offset+=8){const chunks=cells.map(c=>c.slice(offset,offset+8));if(offset>0)chunks[0]=[...wrap(safe(row.name),bold,8,colWidths[0]-14),'(lanjutan)'];const rowHeight=Math.max(43,Math.max(...chunks.map(c=>c.length))*10+16);if(y-rowHeight<42){page=pdf.addPage([width,height]);header();}let x=margin;for(let i=0;i<chunks.length;i++){page.drawRectangle({x,y:y-rowHeight,width:colWidths[i],height:rowHeight,color:stripe%2===0?pale:rgb(1,1,1),borderColor:line,borderWidth:.4});chunks[i].forEach((text,n)=>page.drawText(text,{x:x+7,y:y-14-n*10,size:i===0?8:7.4,font:i===0?bold:regular,color:ink}));x+=colWidths[i];}y-=rowHeight;stripe++;}}
 if(!rows.length)page.drawText('Belum ada jadwal yang di-commit untuk minggu ini.',{x:margin,y:y-30,size:10,font:regular,color:muted});
 const pages=pdf.getPages();pages.forEach((p,i)=>{p.drawText('Jam merupakan durasi jadwal; istirahat dan upah dihitung terpisah.',{x:margin,y:23,size:7,font:regular,color:muted});p.drawText(`${i+1} / ${pages.length}`,{x:width-margin-35,y:23,size:7,font:regular,color:muted});if(replaced)p.drawText('Beberapa karakter nama tidak didukung font; gunakan kode staff sebagai referensi.',{x:margin,y:12,size:6,font:regular,color:muted});});
 return pdf.save();
}
