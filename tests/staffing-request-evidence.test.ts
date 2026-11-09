import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls=vi.hoisted(()=>({actor:vi.fn(),rpc:vi.fn()}));
vi.mock('@/lib/staffing/service',async()=>{const actual=await vi.importActual<typeof import('@/lib/staffing/service')>('@/lib/staffing/service');return {...actual,staffingActor:calls.actor};});
vi.mock('@/lib/supabase/admin',()=>({getSupabaseAdmin:()=>({rpc:calls.rpc})}));
import { GET } from '@/app/api/staffing/evidence/route';
const id='10000000-0000-0000-0000-000000000001';
beforeEach(()=>{calls.actor.mockReset().mockResolvedValue({p_actor:'manager',p_bootstrap:false});calls.rpc.mockReset().mockResolvedValue({data:{file_id:'private-medical-proof',mime:'application/pdf'},error:null});vi.stubEnv('STAFFING_TELEGRAM_BOT_TOKEN','test-token');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('region-authorized request evidence proxy',()=>{
 it('fetches proof only after the authorization RPC and serves a safe uncached download',async()=>{
  const send=vi.fn().mockResolvedValueOnce(Response.json({ok:true,result:{file_path:'documents/proof.pdf',file_size:4}})).mockResolvedValueOnce(new Response('%PDF',{headers:{'Content-Type':'application/pdf'}}));vi.stubGlobal('fetch',send);
  const r=await GET(new Request('http://local/api/staffing/evidence?request='+id));
  expect(calls.rpc).toHaveBeenCalledWith('staffing_request_evidence',{p_actor:'manager',p_bootstrap:false,p_request:id});expect(r.status).toBe(200);expect(r.headers.get('content-disposition')).toContain('attachment');expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('content-security-policy')).toContain('sandbox');expect(await r.text()).toBe('%PDF');
 });
 it('never calls Telegram when the request is outside the manager region',async()=>{
  calls.rpc.mockResolvedValue({data:null,error:{message:'FORBIDDEN'}});const send=vi.fn();vi.stubGlobal('fetch',send);
  expect((await GET(new Request('http://local/api/staffing/evidence?request='+id))).status).toBe(403);expect(send).not.toHaveBeenCalled();
 });
 it('rejects ambiguous IDs and unsupported proof types before fetching a file',async()=>{
  const send=vi.fn();vi.stubGlobal('fetch',send);
  expect((await GET(new Request('http://local/api/staffing/evidence?request='+id+'&session='+id))).status).toBe(400);
  calls.rpc.mockResolvedValue({data:{file_id:'file',mime:'text/html'},error:null});expect((await GET(new Request('http://local/api/staffing/evidence?request='+id))).status).toBe(400);expect(send).not.toHaveBeenCalled();
 });
});
