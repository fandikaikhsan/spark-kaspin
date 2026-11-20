import { describe,it,expect,vi } from 'vitest';
import { normalizeUpdate } from '@/lib/staffing/telegram';
import { resolveAttendanceTargets } from '@/lib/staffing/attendance-targets';
const message={message_id:1,date:Math.floor(Date.now()/1000),chat:{id:-1001,type:'supergroup'},from:{id:7001,username:'alice'}};
const normalize=(text:string,extra:object={})=>normalizeUpdate({update_id:1,message:{...message,text,...extra}},'SparkStaffBot');
describe('explicit group attendance mentions',()=>{
 it('supports saya, multiple usernames, commas and explicitly excluding the reporter',()=>{
  expect(normalize('/masuk saya @Bob, @Clara')).toMatchObject({kind:'check_in',includeSelf:true,attendeeRefs:[{username:'bob'},{username:'clara'}]});
  expect(normalize('/pulang@SparkStaffBot @Bob @Clara')).toMatchObject({kind:'check_out',includeSelf:false,attendeeRefs:[{username:'bob'},{username:'clara'}]});
 });
 it('reads numeric Telegram text mentions using UTF-16 offsets, including display names with spaces',()=>{
  const text='/masuk saya 😀 Budi Santoso';const offset=text.indexOf('😀');
  expect(normalize(text,{entities:[{type:'text_mention',offset,length:text.length-offset,user:{id:7002}}]})).toMatchObject({attendeeRefs:[{userId:7002}],includeSelf:true});
 });
 it('keeps commands group-only, refuses free-text IDs and financial instructions, and supports owned batch callbacks',()=>{
  expect(normalize('/masuk saya @Bob',{chat:{id:7001,type:'private'}})).toBeNull();
  expect(normalize('/masuk saya 7002')).toBeNull();expect(normalize('/masuk saya ubah plafon 90000')).toBeNull();
  const callback={update_id:2,callback_query:{id:'click',from:{id:7001},message,data:'ba:c:30000000-0000-0000-0000-000000000001'}};
  expect(normalizeUpdate(callback,'SparkStaffBot')).toMatchObject({kind:'batch_confirm',batchId:'30000000-0000-0000-0000-000000000001'});
  expect(normalizeUpdate({...callback,callback_query:{...callback.callback_query,message:{...message,chat:{id:7001,type:'private'}}}},'SparkStaffBot')).toBeNull();
 });
 it('resolves current linked members, deduplicates people and discovers new aliases in a small store',async()=>{
  const input=normalize('/masuk saya @Bob @Bob')!;
  const get=vi.fn(async(id:number)=>({status:'member',user:{id,username:id===7001?'alice':'bob'}}));
  const result=await resolveAttendanceTargets(input,[{user_id:7001,username:null},{user_id:7002,username:null}],get);
  expect(result.attendeeIds).toEqual([7001,7002]);expect(result.attendanceError).toBeUndefined();expect(get).toHaveBeenCalledTimes(2);
 });
 it('never uses a stale alias, non-member or an unlinked numeric mention as an attendance identity',async()=>{
  const directory=[{user_id:7002,username:'bob'}];
  for(const member of[{status:'member',user:{id:7002,username:'renamed'}},{status:'left',user:{id:7002,username:'bob'}},{status:'member',user:{id:9999,username:'bob'}}]){
   expect((await resolveAttendanceTargets(normalize('/masuk @Bob')!,directory,async()=>member)).attendanceError).toBe(true);
  }
  expect((await resolveAttendanceTargets({...normalize('/masuk saya')!,attendeeRefs:[{userId:9999}]},directory,async()=>({status:'member',user:{id:9999}}))).attendanceError).toBe(true);
 });
 it('does not enumerate large stores for unknown aliases or accept Telegram lookup failures',async()=>{
  const get=vi.fn().mockRejectedValue(new Error('network'));
  const directory=Array.from({length:31},(_,i)=>({user_id:7002+i,username:null}));
  expect((await resolveAttendanceTargets(normalize('/masuk @Bob')!,directory,get)).attendanceError).toBe(true);expect(get).not.toHaveBeenCalled();
  expect((await resolveAttendanceTargets(normalize('/masuk @Bob')!,directory.slice(0,1),get)).attendanceError).toBe(true);
 });
});
