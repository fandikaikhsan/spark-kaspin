import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),dashboard:vi.fn()}));
vi.mock('@/lib/staffing/operations-service',async()=>{
 const actual=await vi.importActual<typeof import('@/lib/staffing/operations-service')>('@/lib/staffing/operations-service');
 return{...actual,operationsRpc:mocks.rpc};
});
vi.mock('@/lib/staffing/service',async()=>{
 const actual=await vi.importActual<typeof import('@/lib/staffing/service')>('@/lib/staffing/service');
 return{...actual,staffingDashboard:mocks.dashboard};
});
import { GET as activity } from '@/app/api/staffing/operations/route';
import { GET as notifications } from '@/app/api/staffing/notifications/route';
const store='10000000-0000-0000-0000-000000000001';
beforeEach(()=>{mocks.rpc.mockReset().mockResolvedValue({rows:[],pending_attendance:[],requests:[]});mocks.dashboard.mockReset().mockResolvedValue({reports:[]});});
describe('weekly Activities API and notifications',()=>{
 it('requests one weekly read with a validated store and Monday',async()=>{
  const response=await activity(new Request(`http://local/api/staffing/operations?view=activity&store=${store}&week=2026-11-16`));
  expect(response.status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith('staffing_activity_week',{p_store:store,p_week:'2026-11-16'});
  expect(response.headers.get('Cache-Control')).toBe('no-store');
 });
 it('rejects malformed dates, non-Mondays and invalid stores before querying data',async()=>{
  for(const query of['week=bad','week=2026-11-17','week=2026-02-30','week=2026-11-16&store=invalid']){
   expect((await activity(new Request('http://local/api/staffing/operations?view=activity&'+query))).status).toBe(400);
  }
  expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('preserves the daily API contract for older consumers',async()=>{
  expect((await activity(new Request('http://local/api/staffing/operations?view=activity&day=2026-11-20'))).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith('staffing_activity',{p_store:null,p_day:'2026-11-20'});
 });
 it('counts the complete unresolved backlog rather than only attendance in the selected week',async()=>{
  mocks.rpc.mockResolvedValue({rows:[{session_id:'recent',verification_state:'pending'}],pending_attendance:[{id:'older'},{id:'recent'}],requests:[]});
  const response=await notifications();const result=await response.json();
  expect(mocks.rpc).toHaveBeenCalledWith('staffing_activity_week',{p_store:null,p_week:null});
  expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({id:'attendance',count:2,title:'Absensi perlu review',href:'/staffing/activities#review-attendance'});expect(result.total).toBe(2);
 });
});
