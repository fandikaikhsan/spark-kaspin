import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { writeFileSync,mkdirSync } from 'node:fs';
import { createWarningPdf } from '@/lib/staffing/warning-document';
import { sendWarningDocument } from '@/lib/staffing/warning-delivery';
import { warningDocument } from './fixtures/warning';
import { monitoringEnd } from '@/lib/staffing/warning-model';
const actor={p_actor:'manager',p_bootstrap:false};
let rpc:ReturnType<typeof vi.fn>,network:ReturnType<typeof vi.fn>;
const response=(data:unknown,status=200)=>Response.json(data,{status});
const reservation=()=>({data:{already_sent:false,token:'delivery-token',telegram_user_id:7002,document:warningDocument},error:null});
const send=()=>sendWarningDocument({rpc},actor,warningDocument.id,warningDocument.recipient_version,warningDocument.document_version);
beforeEach(()=>{vi.stubEnv('STAFFING_TELEGRAM_BOT_TOKEN','200:test');vi.stubEnv('TELEGRAM_BOT_TOKEN','100:other');rpc=vi.fn().mockResolvedValueOnce(reservation()).mockResolvedValue({data:null,error:null});network=vi.fn();vi.stubGlobal('fetch',network);});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('warning PDF and recipient-safe delivery',()=>{
 it('creates issued, draft, cancelled and long multi-page letters from snapshots',async()=>{
  const versions={issued:warningDocument,draft:{...warningDocument,status:'draft' as const,number:null,issued_points:null,points_before:null,points_after:null},revoked:{...warningDocument,status:'revoked' as const,revoked_at:'2026-11-11T01:00:00Z',revocation_reason:'Pemeriksaan tambahan mengoreksi kesimpulan sebelumnya.'},long:{...warningDocument,data:{...warningDocument.data,chronology:Array(55).fill('Uraian kejadian contoh yang telah diperiksa bersama staf terkait.').join('\n'),findings:'Hasil pemeriksaan contoh. '.repeat(65)}}};
  for(const [name,doc]of Object.entries(versions)){const bytes=await createWarningPdf(doc),pdf=await PDFDocument.load(bytes);expect(pdf.getTitle()).toContain(doc.staff_code);expect(pdf.getPageCount()).toBeGreaterThan(0);if(name==='long')expect(pdf.getPageCount()).toBeGreaterThan(2);if(process.env.SP_PDF_REVIEW_DIR){mkdirSync(process.env.SP_PDF_REVIEW_DIR,{recursive:true});writeFileSync(`${process.env.SP_PDF_REVIEW_DIR}/${name}.pdf`,bytes);}}
 });
 it('clamps the editable six-month default at month-end',()=>{expect(monitoringEnd('2026-11-10')).toBe('2027-05-09');expect(monitoringEnd('2026-08-31')).toBe('2027-02-27');});
 it('checks the linked private chat and sends only to the reserved server recipient',async()=>{
  network.mockResolvedValueOnce(response({ok:true,result:{id:7002,type:'private'}})).mockResolvedValueOnce(response({ok:true,result:{message_id:90,chat:{id:7002,type:'private'}}}));expect(await send()).toMatchObject({state:'sent'});
  expect(JSON.parse(network.mock.calls[0][1].body)).toEqual({chat_id:7002});const form=network.mock.calls[1][1].body as FormData;expect(form.get('chat_id')).toBe('7002');expect(form.get('protect_content')).toBe('true');expect((form.get('document')as Blob).type).toBe('application/pdf');expect(rpc.mock.calls.at(-1)).toEqual(['staffing_warning_finish_delivery',{p_warning:warningDocument.id,p_token:'delivery-token',p_state:'sent',p_message:90}]);
 });
 it('refuses group and mismatched Telegram chats before uploading',async()=>{for(const chat of[{id:-1001,type:'group'},{id:9999,type:'private'}]){rpc.mockReset().mockResolvedValueOnce(reservation()).mockResolvedValue({data:null,error:null});network.mockReset().mockResolvedValueOnce(response({ok:true,result:chat}));await expect(send()).rejects.toThrow('belum terkirim');expect(network).toHaveBeenCalledOnce();expect(rpc.mock.calls.at(-1)?.[1].p_state).toBe('failed');}});
 it('does not send for stale recipient/document bindings or repeat completed delivery',async()=>{for(const message of['WARNING_RECIPIENT_CHANGED','WARNING_STALE']){rpc.mockReset().mockResolvedValue({data:null,error:{message}});await expect(send()).rejects.toThrow('berubah');}rpc.mockReset().mockResolvedValue({data:{already_sent:true},error:null});expect(await send()).toMatchObject({already_sent:true});expect(network).not.toHaveBeenCalled();});
 it('leaves timed-out uploads uncertain with no automatic retries',async()=>{network.mockResolvedValueOnce(response({ok:true,result:{id:7002,type:'private'}})).mockRejectedValueOnce(new Error('timeout'));await expect(send()).rejects.toThrow('belum dapat dipastikan');expect(network).toHaveBeenCalledTimes(2);expect(rpc.mock.calls.at(-1)?.[1].p_state).toBe('uncertain');});
 it('does not trust a successful response containing another recipient',async()=>{network.mockResolvedValueOnce(response({ok:true,result:{id:7002,type:'private'}})).mockResolvedValueOnce(response({ok:true,result:{message_id:90,chat:{id:9999,type:'private'}}}));await expect(send()).rejects.toThrow('belum dapat dipastikan');expect(rpc.mock.calls.at(-1)?.[1].p_state).toBe('uncertain');});
 it('records explicit Telegram rejection as failed, allowing deliberate retry',async()=>{network.mockResolvedValueOnce(response({ok:true,result:{id:7002,type:'private'}})).mockResolvedValueOnce(response({ok:false,description:'bot blocked'},403));await expect(send()).rejects.toThrow('belum terkirim');expect(rpc.mock.calls.at(-1)?.[1].p_state).toBe('failed');});
});
