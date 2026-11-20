import { readFileSync,readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { calculatePayroll } from '@/lib/staffing/payroll';
import type { PayrollInput } from '@/lib/staffing/operations-model';
import type { AttendanceUpdate } from '@/lib/staffing/telegram';
let db:PGlite,staff:string[],seq=0,msg=100;
const store='10000000-0000-0000-0000-000000000001';
async function val<T=unknown>(sql:string,args:unknown[]=[]):Promise<T>{return(await db.query<{v:T}>(sql,args)).rows[0]?.v;}
async function manage(action:string,data:object){return val<{id:string}>('select staffing_manage(null,true,$1,$2::jsonb)as v',[action,JSON.stringify(data)]);}
function update(kind:AttendanceUpdate['kind'],extra:Partial<AttendanceUpdate>={}):AttendanceUpdate{return{updateId:++seq,kind,attendanceVersion:2,userId:7001,chatId:-1001,chatType:'supergroup',messageId:++msg,replyTo:null,sentAt:new Date().toISOString(),timestampSource:'telegram_message',...extra};}
async function apply(u:AttendanceUpdate){await db.query('select staffing_apply_update($1::jsonb)',[JSON.stringify(u)]);return u;}
async function batch(){return val<{id:string;state:string;prompt_message_id:number;requested_at:string}>('select to_jsonb(b)as v from staffing_attendance_batches b order by requested_at desc limit 1');}
async function drain(){for(let i=0;i<100;i++){const row=await val<{id:number}>('select to_jsonb(o)as v from staffing_claim_outbox()o');if(!row)return;await db.query('select staffing_deliver_outbox($1,$2)',[row.id,++msg]);}}
async function finish(){let b=await batch();await apply(update('batch_confirm',{batchId:b.id,sentAt:null}));await drain();b=await batch();await apply(update('location',{replyTo:b.prompt_message_id,latitude:-.8,longitude:119.8}));await drain();b=await batch();const photo=update('photo',{replyTo:b.prompt_message_id,fileId:'shared-photo',fileUniqueId:'shared-unique'});await apply(photo);return photo;}
async function outside(){await db.query('delete from staffing_shifts where staff_id=$1',[staff[0]]);await apply(update('check_in'));await drain();await finish();return val<{id:string;review_version:string}>('select value as v from jsonb_array_elements(staffing_unplanned_view(null,true,null,null))');}
beforeAll(async()=>{db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;');await db.exec(readFileSync('supabase/schema.sql','utf8'));for(const f of readdirSync('supabase/migrations').filter(f=>f.includes('_staffing_')).sort())await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));},30000);
afterAll(async()=>db.close());
beforeEach(async()=>{
 await db.exec('truncate stores,app_users,staffing_regions,staffing_audit,staffing_operation_keys,staffing_inbox,staffing_outbox cascade');await db.query("insert into stores(id,name,time_zone,utc_offset)values($1,'Palu','Asia/Makassar','+08:00')",[store]);const region=(await manage('region',{name:'Palu'})).id;await manage('store_region',{store_id:store,region_id:region});await manage('group',{store_id:store,chat_id:-1001});staff=[];
 for(let i=0;i<3;i++){const id=(await manage('staff',{code:'STAFF-'+i,full_name:['Alice','Bob','Clara'][i],home_store_id:store})).id;staff.push(id);await db.query('update staffing_staff set telegram_user_id=$2 where id=$1',[id,7001+i]);await manage('shift',{staff_id:id,store_id:store,label:'Now',starts_at:new Date(Date.now()-3600000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});}
});
describe('shared group attendance evidence',()=>{
 it('records A/B/C separately with one location and photo, original command time and independent reviews',async()=>{
  const command=await apply(update('check_in',{attendeeIds:[7001,7002,7003]}));await drain();const photo=await finish();await apply(photo);
  expect(await val('select count(*)::int as v from staffing_sessions')).toBe(3);
  expect(await val('select count(distinct check_in_at)::int as v from staffing_sessions')).toBe(1);
  expect(await val('select min(check_in_at)as v from staffing_sessions')).toEqual(new Date(command.sentAt!));
  expect(await val("select count(*)::int as v from staffing_attempts where photo_file_id='shared-photo'and latitude=-.8 and longitude=119.8")).toBe(3);
  expect(await val('select count(*)::int as v from staffing_events')).toBe(3);
  const id=await val<string>('select id as v from staffing_sessions where staff_id=$1',[staff[1]]);const meta=await val<{review_version:string;shared_evidence_count:number}>('select staffing_attendance_metadata($1)as v',[id]);expect(meta.shared_evidence_count).toBe(3);
  await db.query('select staffing_review_attendance(null,true,$1::jsonb)',[JSON.stringify({session_id:id,version:meta.review_version,client_id:randomUUID(),state:'confirmed',note:'',correct_times:false})]);
  expect(await val("select count(*)::int as v from staffing_sessions where verification_state='pending'")).toBe(2);
  expect(await val("select payload->>'text'as v from staffing_outbox order by id desc limit 1")).toBe('Review absensi dikonfirmasi. Lihat /absensi untuk waktu terbaru.');
 });
 it('allows grouped checkout and does not close unselected staff sessions',async()=>{
  await apply(update('check_in',{attendeeIds:[7001,7002,7003]}));await drain();await finish();await apply(update('check_out',{attendeeIds:[7001,7002]}));await drain();await finish();
  expect(await val('select count(*)::int as v from staffing_sessions where check_out_at is not null')).toBe(2);
  expect(await val('select check_out_at is null as v from staffing_sessions where staff_id=$1',[staff[2]])).toBe(true);
 });
 it('requires every selected staff to have check-in before checkout, with no partial group write',async()=>{
  await apply(update('check_in'));await drain();await finish();const before=await val('select count(*)::int as v from staffing_attendance_batches');
  await apply(update('check_out',{attendeeIds:[7001,7002]}));expect(await val('select count(*)::int as v from staffing_attendance_batches')).toBe(before);
  expect(await val('select check_out_at is null as v from staffing_sessions')).toBe(true);
  expect(await val("select payload->>'text'as v from staffing_outbox order by id desc limit 1")).toContain('Bob belum memiliki catatan masuk');
 });
 it('rejects private commands, other actors, wrong chats and expired shared evidence',async()=>{
  await apply(update('check_in',{chatId:7001,chatType:'private',attendeeIds:[7001,7002]}));expect(await batch()).toBeUndefined();
  await apply(update('check_in',{attendeeIds:[7001,7002]}));await drain();const b=await batch();
  await apply(update('batch_confirm',{batchId:b.id,userId:7002}));await apply(update('batch_confirm',{batchId:b.id,chatId:-1002}));expect((await batch()).state).toBe('confirmation');
  await db.query("update staffing_attendance_batches set expires_at=now()-interval '1 second'");await apply(update('batch_confirm',{batchId:b.id}));expect((await batch()).state).toBe('cancelled');expect(await val('select count(*)::int as v from staffing_sessions')).toBe(0);
 });
 it('prevents another reporter from interrupting an in-progress shared group',async()=>{
  await apply(update('check_in',{attendeeIds:[7001,7002]}));await apply(update('check_in',{attendeeIds:[7002],userId:7002}));expect(await val('select count(*)::int as v from staffing_attendance_batches')).toBe(1);
 });
});
describe('record-first unscheduled attendance',()=>{
 it('asks for confirmation with schedules, records outside the schedule, shows it in queues and supports checkout',async()=>{
  const u=await outside();expect(u).toBeTruthy();expect(await val('select count(*)::int as v from staffing_sessions')).toBe(0);
  const week=await val<{pending_attendance:{is_unscheduled:boolean}[]}>('select staffing_activity_week(null,true,null,null)as v');expect(week.pending_attendance).toHaveLength(1);expect(week.pending_attendance[0].is_unscheduled).toBe(true);
  const proof=await val<{file_id:string}[]>('select staffing_evidence(null,true,$1,null)as v',[u.id]);expect(proof[0].file_id).toBe('shared-photo');
  await apply(update('check_out'));await drain();await finish();expect(await val('select check_out_at is not null as v from staffing_unplanned_sessions')).toBe(true);
 });
 it('reviews outside attendance independently and materializes a manager-created shift with preserved proof',async()=>{
  const u=await outside();await db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),state:'confirmed',note:'Sudah diperiksa',correct_times:false})]);
  expect((await val<{pending_attendance:unknown[]}>('select staffing_activity_week(null,true,null,null)as v')).pending_attendance).toHaveLength(1);
  const fresh=await val<{review_version:string}>('select value as v from jsonb_array_elements(staffing_unplanned_view(null,true,null,null))');
  await db.query('select staffing_resolve_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:fresh.review_version,client_id:randomUUID(),mode:'schedule',starts_at:new Date(Date.now()-3600000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString(),note:''})]);
  expect(await val('select count(*)::int as v from staffing_sessions')).toBe(1);expect(await val('select resolution_session_id is not null as v from staffing_unplanned_sessions')).toBe(true);
  expect(await val("select count(*)::int as v from staffing_attempts where photo_file_id='shared-photo'")).toBe(1);
 });
 it('approves outside time as overtime only after closed confirmed attendance and preserves idempotency',async()=>{
  const u=await outside();await apply(update('check_out'));await drain();await finish();
  const fresh=await val<{review_version:string}>('select value as v from jsonb_array_elements(staffing_unplanned_view(null,true,null,null))');
  await db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:fresh.review_version,client_id:randomUUID(),state:'confirmed',note:'',correct_times:true,check_in_at:new Date(Date.now()-7200000).toISOString(),check_out_at:new Date(Date.now()-3600000).toISOString()})]);
  const reviewed=await val<{review_version:string}>('select value as v from jsonb_array_elements(staffing_unplanned_view(null,true,null,null))');
  const data={session_id:u.id,version:reviewed.review_version,client_id:randomUUID(),mode:'overtime',note:'Membantu closing di luar jadwal'};
  const resolve=()=>db.query('select staffing_resolve_unplanned(null,true,$1::jsonb)',[JSON.stringify(data)]);await resolve();await resolve();
  expect(await val('select overtime_only as v from staffing_shifts where staff_id=$1',[staff[0]])).toBe(true);
  expect(await val("select count(*)::int as v from staffing_time_approvals where kind='overtime'")).toBe(1);
  expect(await val("select count(*)::int as v from staffing_audit where action='resolve_unplanned'")).toBe(1);
 });
 it.each(['replace','swap'])('handles %s with validated shift snapshots and retains replacing attribution',async(mode)=>{
  const u=await outside();
  const options=await val<{options:{id:string;staff_id:string;version:string}[]}>('select staffing_unplanned_context(null,true,$1)as v',[u.id]);
  const chosen=options.options.find(o=>o.staff_id===staff[1])!;
  let own: {id:string;version:string}|undefined;
  if(mode==='swap'){
   const id=(await manage('shift',{staff_id:staff[0],store_id:store,label:'Given to Bob',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString()})).id;
   own=(await val<{options:{id:string;version:string}[]}>('select staffing_unplanned_context(null,true,$1)as v',[u.id])).options.find(o=>o.id===id);
  }
  await db.query('select staffing_resolve_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),mode,target_shift_id:chosen.id,target_version:chosen.version,own_shift_id:own?.id,own_version:own?.version,note:'Penyesuaian oleh manager'})]);
  expect(await val('select staff_id as v from staffing_shifts where id=$1',[chosen.id])).toBe(staff[0]);
  expect(await val('select replaces_staff_id as v from staffing_shifts where id=$1',[chosen.id])).toBe(staff[1]);
  if(own)expect(await val('select staff_id as v from staffing_shifts where id=$1',[own.id])).toBe(staff[1]);
  expect(await val('select count(*)::int as v from staffing_sessions')).toBe(1);
 });
 it('keeps a stale or already-attended target unchanged and refuses to resolve a rejected outside record',async()=>{
  const u=await outside();const options=await val<{options:{id:string;staff_id:string;version:string}[]}>('select staffing_unplanned_context(null,true,$1)as v',[u.id]);const chosen=options.options.find(o=>o.staff_id===staff[1])!;
  const data={session_id:u.id,version:u.review_version,client_id:randomUUID(),mode:'replace',target_shift_id:chosen.id,target_version:chosen.version};
  await db.query("update staffing_shifts set label='Changed'where id=$1",[chosen.id]);
  await expect(db.query('select staffing_resolve_unplanned(null,true,$1::jsonb)',[JSON.stringify(data)])).rejects.toThrow('berubah');
  expect(await val('select staff_id as v from staffing_shifts where id=$1',[chosen.id])).toBe(staff[1]);
  await db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),state:'rejected',note:'',correct_times:false})]);
  const fresh=await val<{review_version:string}>('select value as v from jsonb_array_elements(staffing_unplanned_view(null,true,null,null))');
  await expect(db.query('select staffing_resolve_unplanned(null,true,$1::jsonb)',[JSON.stringify({...data,version:fresh.review_version,client_id:randomUUID()})])).rejects.toThrow('penolakan');
 });
 it('retains review anomaly acknowledgement and final-payroll protections on outside records',async()=>{
  const u=await outside();const data={session_id:u.id,version:u.review_version,client_id:randomUUID(),state:'confirmed',note:'',correct_times:true,check_in_at:new Date(Date.now()+3600000).toISOString()};
  await expect(db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify(data)])).rejects.toThrow('ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED');
  await db.query("insert into staffing_payrolls(staff_id,period_start,period_end,source_version,result,created_by)values($1,'2026-01-01','2030-12-31','final','{}','test')",[staff[0]]);
  await expect(db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify({...data,acknowledge_time_anomalies:true})])).rejects.toThrow('payroll sudah final');
 });
 it('does not duplicate a group when an open session changes before the shared photo arrives',async()=>{
  await apply(update('check_in',{attendeeIds:[7001,7002]}));await drain();
  const other=(await manage('shift',{staff_id:staff[0],store_id:store,label:'Earlier',starts_at:new Date(Date.now()-86400000).toISOString(),ends_at:new Date(Date.now()-82800000).toISOString()})).id;
  await db.query('insert into staffing_sessions(staff_id,shift_id,check_in_at)values($1,$2,now())',[staff[0],other]);
  await finish();expect((await batch()).state).toBe('cancelled');expect(await val('select count(*)::int as v from staffing_sessions')).toBe(1);
 });
 it('formats optional note suffixes consistently',async()=>{
  expect(await val("select staffing_note_suffix(null)as v")).toBe('');expect(await val("select staffing_note_suffix('  ')as v")).toBe('');expect(await val("select staffing_note_suffix(' diperiksa ')as v")).toBe('\nCatatan: diperiksa');
 });
 it('passes the new batch readiness postflight',async()=>{const results=await db.exec(readFileSync('supabase/checks/staffing-batch-attendance-postflight.sql','utf8'));expect(Object.values(results.flatMap(r=>r.rows)[0]).every(v=>v===true)).toBe(true);});

 it('keeps proof, review and resolution inaccessible to a manager outside the destination scope',async()=>{
  const u=await outside();const actor='90000000-0000-0000-0000-000000000001';await db.query("insert into app_users(id,username,normalized_username,password_hash,role)values($1,'outsider','outsider','test','manager')",[actor]);
  expect(await val('select staffing_unplanned_view($1,false,null,null)as v',[actor])).toEqual([]);
  expect(await val('select staffing_evidence($1,false,$2,null)as v',[actor,u.id])).toEqual([]);
  await expect(db.query('select staffing_review_unplanned($1,false,$2::jsonb)',[actor,JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),state:'confirmed'})])).rejects.toThrow('FORBIDDEN');
  await expect(db.query('select staffing_resolve_unplanned($1,false,$2::jsonb)',[actor,JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),mode:'schedule'})])).rejects.toThrow('FORBIDDEN');
 });
 it('keeps legacy single-attendance commands active during SQL-before-app rollout',async()=>{
  const command=update('check_in');delete command.attendanceVersion;await apply(command);
  expect(await batch()).toBeUndefined();expect(await val('select count(*)::int as v from staffing_attempts')).toBe(1);
 });
 it('bounds a shared prompt and cancels the entire group if a selected staff becomes inactive',async()=>{
  await apply(update('check_in',{attendeeIds:[7001,7002,7003]}));await drain();
  expect((await val<string>("select payload->>'text'as v from staffing_outbox order by id limit 1")).length).toBeLessThan(4096);
  await db.query('update staffing_staff set active=false where id=$1',[staff[1]]);await finish();expect((await batch()).state).toBe('cancelled');expect(await val('select count(*)::int as v from staffing_sessions')).toBe(0);
 });

 it('blocks payroll while group proof or unresolved outside work exists, excluding rejected outside work',async()=>{
  await db.query('delete from staffing_shifts where staff_id=$1',[staff[0]]);
  await db.query("select staffing_operations(null,true,'payroll_rule',$1::jsonb)",[JSON.stringify({staff_id:staff[0],effective_from:'2020-01-01',normal_rate:11000,day_hours:8,night_enabled:false,night_start:'22:00',night_end:'06:00',overtime_percent:125,late_tiers:[],frequency_tiers:[]})]);
  const day=await val<string>("select (now()at time zone 'Asia/Makassar')::date::text as v");
  const source=()=>val<{input:PayrollInput}>('select staffing_payroll_source(null,true,$1,$2::date,$2::date)as v',[staff[0],day]);
  await apply(update('check_in'));expect((await source()).input.pending_attendance_batches).toHaveLength(1);
  expect(calculatePayroll((await source()).input).blockers.join(' ')).toContain('verifikasi absensi');
  await drain();await finish();expect((await source()).input.pending_attendance_batches).toEqual([]);expect((await source()).input.unplanned_attendance).toHaveLength(1);
  expect(calculatePayroll((await source()).input).blockers.join(' ')).toContain('di luar jadwal');
  const u=await val<{id:string;review_version:string}>('select value as v from jsonb_array_elements(staffing_unplanned_view(null,true,null,null))');
  await db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),state:'rejected',note:'',correct_times:false})]);
  expect((await source()).input.unplanned_attendance).toEqual([]);
 });

 it('rejects stale review after the work store timezone changes',async()=>{
  const u=await outside();await db.query("update stores set time_zone='Asia/Jayapura',utc_offset='+09:00'where id=$1",[store]);
  await expect(db.query('select staffing_review_unplanned(null,true,$1::jsonb)',[JSON.stringify({session_id:u.id,version:u.review_version,client_id:randomUUID(),state:'rejected',correct_times:false})])).rejects.toThrow('ATTENDANCE_STALE');
 });

});
