import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),actor:vi.fn()}));
vi.mock('@/lib/staffing/service',async()=>{
 const actual=await vi.importActual<typeof import('@/lib/staffing/service')>('@/lib/staffing/service');
 return{...actual,staffingActor:mocks.actor};
});
vi.mock('@/lib/supabase/admin',()=>({getSupabaseAdmin:()=>({rpc:mocks.rpc})}));
import { operate } from '@/lib/staffing/operations-service';
const data={session_id:'10000000-0000-0000-0000-000000000001',client_id:'20000000-0000-0000-0000-000000000001',version:'version',state:'confirmed',correct_times:false};
beforeEach(()=>{mocks.actor.mockReset().mockResolvedValue({p_actor:'authenticated-manager',p_bootstrap:false});mocks.rpc.mockReset().mockResolvedValue({data:{id:data.session_id},error:null});});
describe('attendance review service',()=>{
 it('accepts only explicit boolean acknowledgement for both current and legacy review actions',async()=>{
  for(const action of['review_attendance','attendance_review'])for(const flag of[true,false,'true',1,undefined]){
   await operate(action,{...data,acknowledge_time_anomalies:flag,p_actor:'spoofed',p_bootstrap:true});
   const [name,args]=mocks.rpc.mock.calls.at(-1)!;
   expect(name).toBe('staffing_review_attendance');
   expect(args.p_actor).toBe('authenticated-manager');expect(args.p_bootstrap).toBe(false);
   expect(args.p_data.acknowledge_time_anomalies).toBe(flag===true);
  }
 });
 it('converts edited times using the work store timezone even when manager device timezone differs',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:{time_zone:'Asia/Makassar'},error:null});
  await operate('review_attendance',{...data,correct_times:true,check_in_local:'2026-11-20T08:00:00',check_out_local:'2026-11-20T07:00:00',acknowledge_time_anomalies:true});
  const args=mocks.rpc.mock.calls.at(-1)![1];
  expect(args.p_data.check_in_at).toBe('2026-11-20T00:00:00.000Z');
  expect(args.p_data.check_out_at).toBe('2026-11-19T23:00:00.000Z');
 });
 it('turns backend confirmation requirements into readable errors rather than silently accepting',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'P0001',message:'ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED: details'}});
  await expect(operate('review_attendance',data)).rejects.toThrow('konfirmasi penerimaan');
 });
});
