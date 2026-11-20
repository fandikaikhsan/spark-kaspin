import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { attendanceTimeWarnings } from '@/lib/staffing/attendance-time-warnings';
let db: PGlite;
const store='10000000-0000-0000-0000-000000000001', remote='10000000-0000-0000-0000-000000000002';
const manager='20000000-0000-0000-0000-000000000001', outsider='20000000-0000-0000-0000-000000000002';
let staff:string, session:string;
async function value<T=unknown>(sql:string,args:unknown[]=[]):Promise<T>{return(await db.query<{v:T}>(sql,args)).rows[0]?.v;}
async function manage(action:string,data:object){return value<{id:string}>('select staffing_manage(null,true,$1,$2::jsonb)as v',[action,JSON.stringify(data)]);}
async function payload(extra:object={}){const meta=await value<{review_version:string}>('select staffing_attendance_metadata($1)as v',[session]);return{session_id:session,client_id:randomUUID(),version:meta.review_version,state:'confirmed',note:'',correct_times:false,...extra};}
async function review(data:object,actor=manager){return value('select staffing_review_attendance($1,false,$2::jsonb)as v',[actor,JSON.stringify(data)]);}
beforeAll(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;');
 await db.exec(readFileSync('supabase/schema.sql','utf8'));
 for(const file of readdirSync('supabase/migrations').filter(f=>f.includes('_staffing_')).sort())await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
},30000);
afterAll(async()=>db.close());
beforeEach(async()=>{
 await db.exec('truncate stores,app_users,staffing_regions,staffing_audit,staffing_operation_keys,staffing_inbox,staffing_outbox cascade');
 await db.query("insert into stores(id,name,time_zone,utc_offset)values($1,'Store','Asia/Makassar','+08:00'),($2,'Remote','Asia/Jayapura','+09:00')",[store,remote]);
 for(const [id,name]of[[manager,'manager'],[outsider,'outsider']])await db.query("insert into app_users(id,username,normalized_username,password_hash,role)values($1,$2,$2,'test','manager')",[id,name]);
 for(const [id,name,user]of[[store,'A',manager],[remote,'B',outsider]]){
  const region=(await manage('region',{name})).id;
  await manage('store_region',{store_id:id,region_id:region});await manage('manager_region',{user_id:user,region_id:region});
 }
 staff=(await manage('staff',{code:'A',full_name:'Alice',home_store_id:store})).id;
 await db.query('update staffing_staff set telegram_user_id=7001 where id=$1',[staff]);
 const shift=(await manage('shift',{staff_id:staff,store_id:store,label:'Test',starts_at:'2026-10-05T08:00:00+08:00',ends_at:'2026-10-05T16:00:00+08:00'})).id;
 session=await value<string>("insert into staffing_sessions(staff_id,shift_id,check_in_at,check_out_at)values($1,$2,'2026-10-05T08:00:00+08:00','2026-10-08T16:00:00+08:00')returning id as v",[staff,shift]);
});
describe('manager review of anomalous attendance',()=>{
 it('rejects a long session without an override, preserving original evidence and notifying privately',async()=>{
  await review(await payload({state:'rejected'}));
  expect(await value('select verification_state as v from staffing_sessions')).toBe('rejected');
  expect(await value('select corrected_in_at is null and corrected_out_at is null as v from staffing_sessions')).toBe(true);
  expect(await value("select jsonb_agg(payload->'chat_id')as v from staffing_outbox")).toEqual([7001]);
 });
 it('requires explicit boolean acknowledgement to accept an anomaly and audits it once across retries',async()=>{
  const data=await payload();
  for(const flag of[undefined,false,'true'])await expect(review({...data,acknowledge_time_anomalies:flag})).rejects.toThrow('ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED');
  expect(await value('select verification_state as v from staffing_sessions')).toBe('pending');
  await review({...data,acknowledge_time_anomalies:true});await review({...data,acknowledge_time_anomalies:true});
  const audit=await value<{time_anomalies_acknowledged:boolean;time_anomalies:string[]}>("select details as v from staffing_audit where action='review_attendance'");
  expect(audit.time_anomalies_acknowledged).toBe(true);expect(audit.time_anomalies).toEqual(['Periksa waktu aktual. Durasi melebihi 48 jam.']);
  expect(await value("select count(*)::int as v from staffing_audit where action='review_attendance'")).toBe(1);
 });
 it.each(['rejected','confirmed'])('can retain an inverted correction when %s, requiring acknowledgement only for acceptance',async(state)=>{
  const data=await payload({state,correct_times:true,check_in_at:'2026-10-05T18:00:00+08:00',check_out_at:'2026-10-05T16:00:00+08:00'});
  if(state==='confirmed')await expect(review(data)).rejects.toThrow('ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED');
  await review({...data,acknowledge_time_anomalies:state==='confirmed'});
  expect(await value('select corrected_out_at<corrected_in_at as v from staffing_sessions')).toBe(true);
  expect(await value('select verification_state as v from staffing_sessions')).toBe(state);
  expect(await value("select check_in_at='2026-10-05T08:00:00+08:00'and check_out_at='2026-10-08T16:00:00+08:00'as v from staffing_sessions")).toBe(true);
 });
 it.each(['rejected','confirmed'])('allows review of future timestamps when %s while exposing the specific warnings',async(state)=>{
  const data=await payload({state,correct_times:true,check_in_at:new Date(Date.now()+3600000).toISOString(),check_out_at:new Date(Date.now()+7200000).toISOString()});
  if(state==='confirmed')await expect(review(data)).rejects.toThrow('ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED');
  await review({...data,acknowledge_time_anomalies:state==='confirmed'});
  const audit=await value<{time_anomalies:string[]}>("select details as v from staffing_audit where action='review_attendance'");
  expect(audit.time_anomalies).toEqual(['Waktu salah. Jam masuk berada di masa depan.','Waktu salah. Jam pulang berada di masa depan.']);
 });
 it('supports normal review and a still-open session without requiring an anomaly override',async()=>{
  await db.query("update staffing_sessions set check_out_at='2026-10-05T16:00:00+08:00'");
  await review(await payload());
  expect(await value('select verification_state as v from staffing_sessions')).toBe('confirmed');
  await db.query("update staffing_sessions set check_out_at=null,verification_state='pending'");
  await review(await payload());
  expect(await value('select verification_state as v from staffing_sessions')).toBe('confirmed');
 });
 it('retains authorization, stale-write, original checkout and final-payroll protections for overrides',async()=>{
  const data=await payload({acknowledge_time_anomalies:true});
  await expect(review(data,outsider)).rejects.toThrow('FORBIDDEN');
  await expect(review({...data,correct_times:true,check_in_at:'2026-10-05T08:00:00+08:00',check_out_at:null})).rejects.toThrow('tidak dapat dikosongkan');
  await review(await payload({state:'rejected'}));await expect(review(data)).rejects.toThrow('ATTENDANCE_STALE');
  await db.query("insert into staffing_payrolls(staff_id,period_start,period_end,source_version,result,created_by)values($1,'2026-10-01','2026-10-31','final','{}','test')",[staff]);
  await expect(review(await payload({acknowledge_time_anomalies:true}))).rejects.toThrow('payroll final');
 });
 it('keeps unreviewed inverted writes blocked and client roles away from review functions',async()=>{
  await expect(db.query("update staffing_sessions set check_out_at=check_in_at-interval '1 hour'")).rejects.toThrow('staffing_sessions_reviewed_time_order');
  for(const role of['anon','authenticated'])expect(await value("select has_function_privilege($1,'staffing_review_attendance(uuid,boolean,jsonb)','execute')as v",[role])).toBe(false);
 });
 it('matches store-local UI warnings to the database at the 48-hour boundary and for multiple anomalies',async()=>{
  const cases=[['2026-10-05T08:00:00+08:00','2026-10-07T08:00:00+08:00'],['2026-10-05T08:00:00+08:00','2026-10-07T08:00:01+08:00'],['2026-10-05T08:00:00+08:00','2026-10-05T07:00:00+08:00'],[new Date(Date.now()+86400000).toISOString(),new Date(Date.now()+90000000).toISOString()],['2026-10-05T08:00:00+08:00',null]];
  for(const [start,end]of cases)expect(await value('select staffing_attendance_time_warnings($1,$2)as v',[start,end])).toEqual(attendanceTimeWarnings(start!,end,new Date()));
 });
 it('passes the read-only anomaly postflight',async()=>{
  const results=await db.exec(readFileSync('supabase/checks/staffing-attendance-anomaly-review-postflight.sql','utf8'));
  expect(Object.values(results.flatMap(r=>r.rows)[0]).every(v=>v===true)).toBe(true);
 });
});
