import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
let db: PGlite;
const storeA="10000000-0000-0000-0000-000000000001",storeB="10000000-0000-0000-0000-000000000002",manager="20000000-0000-0000-0000-000000000001";
const week="2026-11-09";
type Row={id:string;staff_id:string;label:string;starts_at:string;ends_at:string;locked?:boolean;editable?:boolean};
type Snapshot={version:string;shifts:Row[];staff:{id:string}[];busy:Row[]};
let alice:string,bob:string,eve:string;
async function value<T>(sql:string,args:unknown[]=[]){return(await db.query<{result:T}>(sql,args)).rows[0].result;}
async function manage(action:string,data:object){return value<{id:string}>("select staffing_manage(null,true,$1,$2::jsonb) as result",[action,JSON.stringify(data)]);}
async function snapshot(store=storeA,actor:string|null=null,bootstrap=true){return value<Snapshot>("select staffing_schedule_week($1::uuid,$2,$3::uuid,$4::date) as result",[actor,bootstrap,store,week]);}
function row(staffId:string,day:number=9,start="08:00",end="16:00"){return {id:null,staff_id:staffId,label:"Middle",starts_at:`2026-11-${String(day).padStart(2,"0")}T${start}:00+07:00`,ends_at:`2026-11-${String(day).padStart(2,"0")}T${end}:00+07:00`};}
async function commit(shifts:object[],version:string,store=storeA,actor:string|null=null,bootstrap=true){return value<Snapshot>("select staffing_commit_week($1::uuid,$2,$3::uuid,$4::date,$5,$6::jsonb) as result",[actor,bootstrap,store,week,version,JSON.stringify(shifts)]);}
beforeAll(async()=>{db=new PGlite();await db.exec("create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;");for(const file of ["supabase/schema.sql","supabase/migrations/20261107180000_staffing_attendance.sql","supabase/migrations/20261107193000_staffing_weekly_schedule.sql"])await db.exec(readFileSync(file,"utf8"));},30000);
afterAll(async()=>{await db.close();});
beforeEach(async()=>{
 await db.exec("truncate stores,app_users,staffing_regions,staffing_audit,staffing_outbox,staffing_inbox cascade");
 await db.query("insert into stores(id,name,time_zone,utc_offset) values($1,'A','Asia/Jakarta','+07:00'),($2,'B','Asia/Makassar','+08:00')",[storeA,storeB]);
 await db.query("insert into app_users(id,username,normalized_username,password_hash,role) values($1,'manager','manager','test','manager')",[manager]);
 const a=(await manage('region',{name:'A'})).id,b=(await manage('region',{name:'B'})).id;
 await manage('store_region',{store_id:storeA,region_id:a});await manage('store_region',{store_id:storeB,region_id:b});await manage('manager_region',{user_id:manager,region_id:a});
 alice=(await manage('staff',{code:'A',full_name:'Alice',home_store_id:storeA})).id;bob=(await manage('staff',{code:'B',full_name:'Bob',home_store_id:storeA})).id;eve=(await manage('staff',{code:'E',full_name:'Eve',home_store_id:storeB})).id;
});
describe('atomic weekly schedule commits',()=>{
 it('publishes several shifts in one audited commit, then moves/resizes/deletes them',async()=>{
  let data=await snapshot();data=await commit([row(alice),row(bob)],data.version);expect(data.shifts).toHaveLength(2);
  expect(await value<number>("select count(*)::int as result from staffing_audit where action='commit_week'")).toBe(1);
  const first=data.shifts.find(s=>s.staff_id===alice)!;
  data=await commit([{...first,starts_at:'2026-11-10T09:00:00+07:00',ends_at:'2026-11-10T15:30:00+07:00'}],data.version);
  expect(data.shifts).toHaveLength(1);expect(data.shifts[0].id).toBe(first.id);expect(Date.parse(data.shifts[0].starts_at)).toBe(Date.parse('2026-11-10T09:00:00+07:00'));
 });
 it('rejects a stale editor without deleting or changing its newer schedule',async()=>{
  const initial=await snapshot();const newer=await commit([row(alice)],initial.version);
  await expect(commit([row(bob)],initial.version)).rejects.toThrow('SCHEDULE_STALE');expect((await snapshot()).shifts).toEqual(newer.shifts);
 });
 it('rolls the entire commit back on a single overlap',async()=>{
  const initial=await snapshot();await expect(commit([row(alice),row(alice,9,'15:00','20:00'),row(bob)],initial.version)).rejects.toThrow('SCHEDULE_OVERLAP');
  expect((await snapshot()).shifts).toHaveLength(0);expect(await value<number>("select count(*)::int as result from staffing_audit where action='commit_week'")).toBe(0);
 });
 it('allows two assignments to swap times atomically',async()=>{
  let data=await commit([row(alice),row(alice,10)],(await snapshot()).version);
  const [a,b]=data.shifts;data=await commit([{...a,starts_at:b.starts_at,ends_at:b.ends_at},{...b,starts_at:a.starts_at,ends_at:a.ends_at}],data.version);expect(data.shifts).toHaveLength(2);
 });
 it('enforces region scope on reads, writes and staff identities',async()=>{
  await expect(snapshot(storeB,manager,false)).rejects.toThrow('FORBIDDEN');
  const a=await snapshot(storeA,manager,false);expect(a.staff.map(s=>s.id)).not.toContain(eve);
  await expect(commit([row(eve)],a.version,storeA,manager,false)).rejects.toThrow('FORBIDDEN');
  await expect(commit([row(alice)],a.version,storeB,manager,false)).rejects.toThrow('FORBIDDEN');
  expect((await commit([row(alice)],a.version,storeA,manager,false)).shifts).toHaveLength(1);
 });
 it('detects another-store conflicts without exposing its store details',async()=>{
  await manage('shift',{...row(alice),store_id:storeB});
  const data=await snapshot(storeA,manager,false);expect(data.busy).toHaveLength(1);expect(data.busy[0]).not.toHaveProperty('label');expect(data.busy[0]).not.toHaveProperty('store_id');
  await expect(commit([row(alice)],data.version,storeA,manager,false)).rejects.toThrow('SCHEDULE_OVERLAP');
 });
 it('locks attended shifts while allowing unrelated changes in the same commit',async()=>{
  let data=await commit([row(alice)],(await snapshot()).version);const original=data.shifts[0];
  await db.query('insert into staffing_sessions(shift_id,staff_id,check_in_at) values($1,$2,$3)',[original.id,alice,original.starts_at]);
  data=await snapshot();expect(data.shifts[0].locked).toBe(true);
  await expect(commit([],data.version)).rejects.toThrow('SCHEDULE_LOCKED');
  await expect(commit([{...original,ends_at:'2026-11-09T17:00:00+07:00'}],data.version)).rejects.toThrow('SCHEDULE_LOCKED');
  expect((await commit([original,row(bob)],data.version)).shifts).toHaveLength(2);
 });
 it('also protects in-progress/cancelled attendance verification evidence',async()=>{
  const data=await commit([row(alice)],(await snapshot()).version);const original=data.shifts[0];
  await db.query("insert into staffing_attempts(staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id) values($1,$2,-1001,'check_in','confirmation',now(),1)",[alice,original.id]);
  await expect(commit([],data.version)).rejects.toThrow('SCHEDULE_LOCKED');
 });
 it('includes a Sunday night carry-in and preserves it when committing the next week',async()=>{
  await manage('shift',{staff_id:alice,store_id:storeA,label:'Night',starts_at:'2026-11-08T22:00:00+07:00',ends_at:'2026-11-09T06:00:00+07:00'});
  const data=await snapshot();expect(data.shifts).toHaveLength(1);expect(data.shifts[0].editable).toBe(false);
  const next=await commit([row(bob)],data.version);expect(next.shifts).toHaveLength(2);
  await expect(commit([{...data.shifts[0]}],next.version)).rejects.toThrow('FORBIDDEN');
 });
 it('rejects next-week conflicts for Sunday overnight placement',async()=>{
  await manage('shift',{staff_id:alice,store_id:storeA,label:'Monday',starts_at:'2026-11-16T04:00:00+07:00',ends_at:'2026-11-16T12:00:00+07:00'});
  const data=await snapshot();expect(data.busy).toHaveLength(1);
  await expect(commit([{...row(alice,15,'22:00','23:00'),ends_at:'2026-11-16T06:00:00+07:00'}],data.version)).rejects.toThrow('SCHEDULE_OVERLAP');
 });
 it('rejects duplicate/forged IDs and invalid durations without partial writes',async()=>{
  const data=await commit([row(alice)],(await snapshot()).version);const original=data.shifts[0];
  await expect(commit([original,original],data.version)).rejects.toThrow('Duplicate shift ID');
  await expect(commit([{...row(bob),id:'90000000-0000-0000-0000-000000000001'}],data.version)).rejects.toThrow('FORBIDDEN');
  await expect(commit([original,row(bob,9,'08:00','08:15')],data.version)).rejects.toThrow('Invalid shift');expect((await snapshot()).shifts).toHaveLength(1);
 });
 it('does not grant browser roles direct commit privileges',async()=>{
  expect(await value<boolean>("select has_function_privilege('authenticated','staffing_commit_week(uuid,boolean,uuid,date,text,jsonb)','execute') as result")).toBe(false);
  expect(await value<boolean>("select has_function_privilege('anon','staffing_schedule_week(uuid,boolean,uuid,date)','execute') as result")).toBe(false);
 });
});
