import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
const calls=vi.hoisted(()=>({actor:vi.fn(),send:vi.fn()}));
vi.mock('@/lib/staffing/service',async()=>{const actual=await vi.importActual<typeof import('@/lib/staffing/service')>('@/lib/staffing/service');return{...actual,staffingActor:calls.actor};});
vi.mock('@/lib/staffing/payroll-delivery',()=>({sendPayrollDocument:calls.send}));
vi.mock('@/lib/supabase/admin',()=>({getSupabaseAdmin:()=>({rpc:vi.fn()})}));
import { POST } from '@/app/api/staffing/payroll/document/route';
const body={payroll_id:'10000000-0000-0000-0000-000000000001',recipient_version:'a'.repeat(32)};
beforeEach(()=>{calls.actor.mockReset().mockResolvedValue({p_actor:'manager',p_bootstrap:false});calls.send.mockReset().mockResolvedValue({state:'sent'});});
afterEach(()=>vi.restoreAllMocks());
const req=(value:object,origin='http://local')=>new Request('http://local/api/staffing/payroll/document',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(value)});
describe('payroll document endpoint',()=>{
 it('forwards only the payroll ID and server-side authenticated manager to the delivery service',async()=>{expect((await POST(req(body))).status).toBe(200);expect(calls.send.mock.calls[0].slice(1)).toEqual([{p_actor:'manager',p_bootstrap:false},body.payroll_id,body.recipient_version]);});
 it('rejects supplied recipient IDs, privileged actors and cross-origin sends before delivery',async()=>{for(const extra of[{chat_id:7002},{staff_id:'other'},{p_bootstrap:true},{telegram_user_id:7002}])expect((await POST(req({...body,...extra}))).status).toBe(400);expect((await POST(req(body,'http://evil'))).status).toBe(403);expect(calls.send).not.toHaveBeenCalled();});
});
