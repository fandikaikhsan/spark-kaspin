import { beforeEach,describe,it,expect,vi } from 'vitest';
const calls=vi.hoisted(()=>({actor:vi.fn(),send:vi.fn(),rpc:vi.fn()}));
vi.mock('@/lib/staffing/service',async()=>{const actual=await vi.importActual<typeof import('@/lib/staffing/service')>('@/lib/staffing/service');return{...actual,staffingActor:calls.actor};});
vi.mock('@/lib/staffing/operations-service',async()=>{const actual=await vi.importActual<typeof import('@/lib/staffing/operations-service')>('@/lib/staffing/operations-service');return{...actual,operationsRpc:calls.rpc};});
vi.mock('@/lib/staffing/warning-delivery',()=>({sendWarningDocument:calls.send}));
vi.mock('@/lib/supabase/admin',()=>({getSupabaseAdmin:()=>({rpc:vi.fn()})}));
import { POST as sendDocument } from '@/app/api/staffing/warnings/document/route';
import { POST as manage, GET } from '@/app/api/staffing/warnings/route';
const id='10000000-0000-0000-0000-000000000001',body={warning_id:id,recipient_version:'a'.repeat(32),document_version:'b'.repeat(32)};
const req=(value:object,origin='http://local')=>new Request('http://local/api/staffing/warnings',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();calls.actor.mockResolvedValue({p_actor:'manager',p_bootstrap:false});calls.send.mockResolvedValue({state:'sent'});calls.rpc.mockResolvedValue({id});});
describe('warning HTTP boundaries',()=>{
 it('derives actor server-side and forwards document and recipient version bindings',async()=>{expect((await sendDocument(req(body))).status).toBe(200);expect(calls.send.mock.calls[0].slice(1)).toEqual([{p_actor:'manager',p_bootstrap:false},id,body.recipient_version,body.document_version]);});
 it('rejects client recipient IDs, privileged actors and cross-origin document sends',async()=>{for(const extra of[{chat_id:7002},{staff_id:id},{p_bootstrap:true},{telegram_user_id:7002}])expect((await sendDocument(req({...body,...extra}))).status).toBe(400);expect((await sendDocument(req(body,'http://evil'))).status).toBe(403);expect(calls.send).not.toHaveBeenCalled();});
 it('whitelists actions and fields instead of accepting arbitrary amounts or actors',async()=>{const data={staff_id:id,points:1,points_version:'a'.repeat(32),reason:'Evaluasi perbaikan',client_id:id};expect((await manage(req({action:'reduce_points',data}))).status).toBe(200);for(const extra of[{p_bootstrap:true},{actor:id},{telegram_user_id:7002},{max_kasbon:9999999}])expect((await manage(req({action:'reduce_points',data:{...data,...extra}}))).status).toBe(400);expect((await manage(req({action:'unknown',data}))).status).toBe(400);expect((await manage(req({action:'reduce_points',data:{...data,points:-1}}))).status).toBe(400);expect(calls.rpc).toHaveBeenCalledTimes(1);});
 it('requires exactly one staff or warning ID for scoped reads',async()=>{expect((await GET(new Request(`http://local/api/staffing/warnings?staff=${id}&warning=${id}`))).status).toBe(400);expect((await GET(new Request(`http://local/api/staffing/warnings?warning=${id}`))).status).toBe(200);expect(calls.rpc).toHaveBeenCalledWith('staffing_warning_detail',{p_warning:id});});
 it('accepts only a nonnegative integer target for manual balance changes',async()=>{const data={staff_id:id,new_balance:0,points_version:'a'.repeat(32),reason:'Koreksi saldo staf',client_id:id};expect((await manage(req({action:'adjust_points',data}))).status).toBe(200);for(const new_balance of[-1,1.5,1000001,'3',null])expect((await manage(req({action:'adjust_points',data:{...data,new_balance}}))).status).toBe(400);expect((await manage(req({action:'adjust_points',data:{...data,p_bootstrap:true}}))).status).toBe(400);expect(calls.rpc).toHaveBeenCalledTimes(1);});

});
