import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { activityWeek, activityWeekLabel } from '@/lib/staffing/activity-view';
import type { ActivityData } from '@/lib/staffing/operations-model';
let db:PGlite, alice:string,guest:string;
const store='10000000-0000-0000-0000-000000000001',remote='10000000-0000-0000-0000-000000000002',manager='20000000-0000-0000-0000-000000000001';
async function value<T=unknown>(sql:string,args:unknown[]=[]):Promise<T>{return(await db.query<{v:T}>(sql,args)).rows[0]?.v;}
async function manage(action:string,data:object){return value<{id:string}>('select staffing_manage(null,true,$1,$2::jsonb)as v',[action,JSON.stringify(data)]);}
async function shift(start:string,end:string,staff=alice,destination=store){return(await manage('shift',{staff_id:staff,store_id:destination,label:'Test',starts_at:start,ends_at:end})).id;}
async function record(shiftId:string,state='pending',staff=alice){return value<string>("insert into staffing_sessions(shift_id,staff_id,check_in_at,check_out_at,verification_state)select id,$2,starts_at,ends_at,$3 from staffing_shifts where id=$1 returning id as v",[shiftId,staff,state]);}
async function week(day='2026-11-16',destination:string|null=store){return value<ActivityData>('select staffing_activity_week($1,false,$2,$3::date)as v',[manager,destination,day]);}
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;');await db.exec(readFileSync('supabase/schema.sql','utf8'));for(const file of readdirSync('supabase/migrations').filter(f=>f.includes('_staffing_')).sort())await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));},30000);
afterAll(async()=>db.close());
beforeEach(async()=>{
 await db.exec('truncate stores,app_users,staffing_regions,staffing_audit,staffing_inbox,staffing_outbox cascade');
 await db.query("insert into stores(id,name,time_zone,utc_offset)values($1,'Palu','Asia/Makassar','+08:00'),($2,'Jayapura','Asia/Jayapura','+09:00')",[store,remote]);
 await db.query("insert into app_users(id,username,normalized_username,password_hash,role)values($1,'manager','manager','test','manager')",[manager]);
 for(const[id,name]of[[store,'A'],[remote,'B']]){const region=(await manage('region',{name})).id;await manage('store_region',{store_id:id,region_id:region});if(id===store)await manage('manager_region',{user_id:manager,region_id:region});}
 alice=(await manage('staff',{code:'A',full_name:'Alice',home_store_id:store})).id;
 guest=(await manage('staff',{code:'B',full_name:'Guest',home_store_id:remote})).id;
});
describe('weekly activity and persistent review backlog',()=>{
 it('returns all seven local days including yesterday and Sunday without duplicating overnight shifts',async()=>{
  const ids=[];
  for(let day=16;day<=22;day++)ids.push(await shift(`2026-11-${day}T08:00:00+08:00`,`2026-11-${day}T16:00:00+08:00`));
  const overnight=await shift('2026-11-15T23:00:00+08:00','2026-11-16T01:00:00+08:00',guest);
  await shift('2026-11-23T00:00:00+08:00','2026-11-23T08:00:00+08:00');
  await shift('2026-11-15T08:00:00+08:00','2026-11-16T00:00:00+08:00');
  const result=await week();
  expect(result.week_start).toBe('2026-11-16');expect(result.week_end).toBe('2026-11-22');
  expect(result.rows).toHaveLength(8);expect(new Set(result.rows.map(r=>r.id))).toEqual(new Set([...ids,overnight]));
 });
 it('keeps older pending attendance in the review queue across weeks and removes it after review',async()=>{
  const old=await shift('2026-11-02T08:00:00+08:00','2026-11-02T16:00:00+08:00');
  const recent=await shift('2026-11-17T08:00:00+08:00','2026-11-17T16:00:00+08:00');
  const sid=await record(old);await record(recent);await record(await shift('2026-11-03T08:00:00+08:00','2026-11-03T16:00:00+08:00'),'confirmed');
  const result=await week();expect(result.rows.map(r=>r.id)).toEqual([recent]);
  expect(result.pending_attendance?.map(r=>r.id)).toEqual([old,recent]);
  expect(result.pending_attendance?.[0].review_version).toBeTruthy();
  expect((await week('2026-11-23')).pending_attendance?.map(r=>r.id)).toEqual([old,recent]);
  const meta=await value<{review_version:string}>('select staffing_attendance_metadata($1)as v',[sid]);
  await db.query("select staffing_review_attendance($1,false,$2::jsonb)",[manager,JSON.stringify({session_id:sid,client_id:'30000000-0000-0000-0000-000000000001',version:meta.review_version,state:'rejected',note:'',correct_times:false})]);
  expect((await week()).pending_attendance?.map(r=>r.id)).toEqual([recent]);
 });
 it('filters both the calendar and review backlog by the authenticated store scope',async()=>{
  await record(await shift('2026-11-17T08:00:00+08:00','2026-11-17T16:00:00+08:00'));
  await record(await shift('2026-11-02T08:00:00+09:00','2026-11-02T16:00:00+09:00',guest,remote),'pending',guest);
  expect((await week('2026-11-16',null)).pending_attendance).toHaveLength(1);
  await expect(week('2026-11-16',remote)).rejects.toThrow('FORBIDDEN');
 });
 it('uses each store timezone at the week boundary and excludes a shift exactly at the next week start',async()=>{
  const a=await shift('2026-11-15T16:00:00Z','2026-11-15T17:00:00Z');
  const b=await shift('2026-11-15T15:00:00Z','2026-11-15T16:00:00Z',guest,remote);
  const outside=await shift('2026-11-22T15:00:00Z','2026-11-22T16:00:00Z',guest,remote);
  const result=await value<ActivityData>('select staffing_activity_week(null,true,null,$1::date)as v',['2026-11-16']);
  expect(new Set(result.rows.map(r=>r.id))).toEqual(new Set([a,b]));expect(result.rows.some(r=>r.id===outside)).toBe(false);
 });
 it('preserves per-shift approved leave, review metadata and guest privacy across the week',async()=>{
  const id=await shift('2026-11-19T08:00:00+08:00','2026-11-19T16:00:00+08:00',guest);
  await record(id,'pending',guest);
  await db.query("insert into staffing_requests(staff_id,kind,payment_mode,start_date,end_date,leave_dates,days,reason,status,created_by)values($1,'sick','sick','2026-11-19','2026-11-19','[{\"date\":\"2026-11-19\",\"units\":1}]',1,'Private diagnosis','approved','test')",[guest]);
  const result=await week();expect(result.rows[0]).toMatchObject({id,approved_leave:true,can_view_profile:false});
  expect(result.rows[0].review_version).toBeTruthy();expect(JSON.stringify(result)).not.toContain('Private diagnosis');
 });
 it('keeps pending personal requests visible independently of calendar navigation',async()=>{
  await db.query("insert into staffing_requests(staff_id,kind,payment_mode,start_date,end_date,leave_dates,days,reason,created_by)values($1,'paid_leave','leave','2026-11-02','2026-11-02','[{\"date\":\"2026-11-02\",\"units\":1}]',1,'Request from earlier week','test')",[alice]);
  expect((await week()).requests).toHaveLength(1);expect((await week('2026-11-23')).requests).toHaveLength(1);
 });
 it('rejects non-Monday queries and protects the new RPC from client database roles',async()=>{
  await expect(week('2026-11-17')).rejects.toThrow('Senin');
  for(const role of['anon','authenticated'])expect(await value("select has_function_privilege($1,'staffing_activity_week(uuid,boolean,uuid,date)','execute')as v",[role])).toBe(false);
 });
 it('passes the weekly production postflight',async()=>{
  const result=await db.exec(readFileSync('supabase/checks/staffing-weekly-activities-postflight.sql','utf8'));
  expect(Object.values(result.flatMap(r=>r.rows)[0]).every(v=>v===true)).toBe(true);
 });
});
describe('weekly activity controls',()=>{
 it('uses the work timezone rather than the manager device date around Sunday midnight',()=>{
  const now=new Date('2026-11-15T15:30:00Z');
  expect(activityWeek(now,'Asia/Jayapura')).toBe('2026-11-16');
  expect(activityWeek(now,'Asia/Makassar')).toBe('2026-11-09');
 });
 it('formats a full Monday–Sunday range across month and year boundaries',()=>{
  expect(activityWeekLabel('2026-12-28')).toBe('28/12/2026 – 03/01/2027');
 });
});
