import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { invitationHash, type AttendanceUpdate } from "@/lib/staffing/telegram";

const transport = vi.hoisted(() => ({ rpc: null as unknown }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...args: unknown[]) => (transport.rpc as (...args: unknown[]) => unknown)(...args) }) }));
import { handler } from "@/aws/lambda/staffing";

let db: PGlite;
let sequence = 0;
let messageId = 1000;
const storeA = "10000000-0000-0000-0000-000000000001";
const storeB = "10000000-0000-0000-0000-000000000002";
const managerA = "20000000-0000-0000-0000-000000000001";
const managerB = "20000000-0000-0000-0000-000000000002";
let alice: string; let bob: string; let shift: string;
async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []) { return (await db.query<T>(sql, params)).rows; }
async function scalar(sql: string, params: unknown[] = []) { return (await rows(sql, params))[0].result; }
async function manage(action: string, data: Record<string, unknown>, actor: string | null = null, bootstrap = true) {
  return await scalar("select staffing_manage($1::uuid,$2,$3,$4::jsonb) as result", [actor, bootstrap, action, JSON.stringify(data)]) as { id: string };
}
async function snapshot(actor: string | null = null, bootstrap = true) { return await scalar("select staffing_dashboard($1::uuid,$2) as result", [actor,bootstrap]) as { sessions: { id: string; check_in_at: string; check_out_at: string | null; corrected_in_at: string | null }[]; stores: {id: string}[]; staff: {id: string}[]; reports: {id: string}[] }; }
function update(kind: AttendanceUpdate["kind"], more: Partial<AttendanceUpdate> = {}): AttendanceUpdate {
  return { updateId: ++sequence, kind, userId: 7001, chatId: -1001, chatType: "supergroup", messageId: ++messageId, replyTo: null, sentAt: new Date().toISOString(), timestampSource: "telegram_message", ...more };
}
async function apply(u: AttendanceUpdate) { await rows("select staffing_apply_update($1::jsonb)", [JSON.stringify(u)]); }
async function attempt(userId = 7001) { return (await rows<{ id: string; state: string; prompt_message_id: number }>("select * from staffing_attempts where staff_id=(select id from staffing_staff where telegram_user_id=$1) order by received_at desc limit 1", [userId]))[0]; }
async function deliverAll() {
  let n = 0;
  while (n++ < 100) {
    const pending = await rows<{id: number}>("select * from staffing_claim_outbox()");
    if (!pending.length) return;
    await rows("select staffing_deliver_outbox($1,$2)", [pending[0].id, ++messageId]);
  }
  throw new Error("Outbox did not drain");
}
async function start(kind: "check_in" | "check_out" = "check_in", userId = 7001, chatId = -1001) {
  await apply(update(kind, { userId, chatId })); await deliverAll();
  const a = await attempt(userId);
  await apply(update("confirm", { userId,chatId,attemptId: a.id,sentAt:null,timestampSource:"server_received" })); await deliverAll();
  return await attempt(userId);
}
async function complete(kind: "check_in" | "check_out" = "check_in", userId = 7001, chatId = -1001) {
  let a = await start(kind,userId,chatId);
  await apply(update("location",{ userId,chatId,replyTo:a.prompt_message_id,latitude:-6.9,longitude:107.7 })); await deliverAll();
  a = await attempt(userId);
  const photo = update("photo",{ userId,chatId,replyTo:a.prompt_message_id,fileId:"telegram-photo",fileUniqueId:"unique-photo" });
  await apply(photo); await deliverAll();
  return photo;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;");
  await db.exec(readFileSync("supabase/schema.sql","utf8"));
  await db.exec("grant usage on schema public to service_role; grant select on stores,app_users to service_role;");
  await db.exec(readFileSync("supabase/migrations/20261107180000_staffing_attendance.sql","utf8"));
},30000);
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await db.close(); });
beforeEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); sequence = 0;
  await db.exec("truncate stores,app_users,staffing_regions,staffing_audit,staffing_outbox,staffing_inbox cascade;");
  await db.query("insert into stores(id,name,time_zone,utc_offset) values($1,'Store A','Asia/Jakarta','+07:00'),($2,'Store B','Asia/Makassar','+08:00')",[storeA,storeB]);
  await db.query("insert into app_users(id,username,normalized_username,password_hash,role) values($1,'manager.a','manager.a','test','manager'),($2,'manager.b','manager.b','test','manager')",[managerA,managerB]);
  const regionA = (await manage("region",{name:"Region A"})).id;
  const regionB = (await manage("region",{name:"Region B"})).id;
  await manage("store_region",{store_id:storeA,region_id:regionA});
  await manage("store_region",{store_id:storeB,region_id:regionB});
  await manage("manager_region",{user_id:managerA,region_id:regionA});
  await manage("manager_region",{user_id:managerB,region_id:regionB});
  alice=(await manage("staff",{code:"A1",full_name:"Alice",home_store_id:storeA})).id;
  bob=(await manage("staff",{code:"A2",full_name:"Bob",home_store_id:storeA})).id;
  await manage("staff",{code:"B1",full_name:"Eve",home_store_id:storeB});
  await db.query("update staffing_staff set telegram_user_id=case id when $1::uuid then 7001 when $2::uuid then 7002 else 7003 end",[alice,bob]);
  await manage("group",{chat_id:"-1001",store_id:storeA});
  await manage("group",{chat_id:"-1002",store_id:storeB});
  shift=(await manage("shift",{staff_id:alice,store_id:storeA,label:"Middle",starts_at:new Date(Date.now()-300000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()})).id;
});

describe("staffing PostgreSQL transactions", () => {
  it("completes check-in/out with location/photo, audit and timestamp provenance",async () => {
    const photo=await complete();
    let data=await snapshot(managerA,false);
    expect(data.sessions).toHaveLength(1);
    expect(Date.parse(data.sessions[0].check_in_at)).toBe(Date.parse(photo.sentAt!));
    expect(data.sessions[0].check_out_at).toBeNull();
    await complete("check_out"); data=await snapshot(managerA,false);
    expect(data.sessions[0].check_out_at).not.toBeNull();
    expect(await scalar("select count(*)::int as result from staffing_events")).toBe(2);
    expect(await scalar("select count(*)::int as result from staffing_audit where action in ('check_in','check_out')")).toBe(2);
    const evidence=await scalar("select staffing_evidence($1,false,$2,null) as result",[managerA,data.sessions[0].id]) as {file_id:string}[];
    expect(evidence).toHaveLength(2); expect(evidence[0].file_id).toBe("telegram-photo");
  });
  it("does not duplicate attendance or notifications on repeated updates",async () => {
    const photo=await complete(); const count=await scalar("select count(*)::int as result from staffing_outbox");
    await apply(photo); await apply(photo);
    expect(await scalar("select count(*)::int as result from staffing_sessions")).toBe(1);
    expect(await scalar("select count(*)::int as result from staffing_events")).toBe(1);
    expect(await scalar("select count(*)::int as result from staffing_outbox")).toBe(count);
    await apply(update("check_in"));
    expect(await scalar("select count(*)::int as result from staffing_sessions")).toBe(1);
  });
  it("rejects another staff member's confirmation and replies to the wrong prompt/group",async () => {
    await apply(update("check_in")); await deliverAll(); let a=await attempt();
    await apply(update("confirm",{userId:7002,attemptId:a.id,sentAt:null})); expect((await attempt()).state).toBe("confirmation");
    await apply(update("confirm",{attemptId:a.id,sentAt:null})); await deliverAll(); a=await attempt();
    await apply(update("location",{replyTo:a.prompt_message_id+999,latitude:1,longitude:1}));
    await apply(update("location",{replyTo:a.prompt_message_id,userId:7002,latitude:1,longitude:1}));
    await apply(update("location",{replyTo:a.prompt_message_id,chatId:-1002,latitude:1,longitude:1}));
    expect((await attempt()).state).toBe("location"); expect((await snapshot()).sessions).toHaveLength(0);
  });
  it("does not finalize missing evidence or expired verification",async () => {
    const a=await start();
    await apply(update("photo",{replyTo:a.prompt_message_id,fileId:"wrong-stage"})); expect((await attempt()).state).toBe("location");
    await db.query("update staffing_attempts set expires_at=now()-interval '1 second' where id=$1",[a.id]);
    await apply(update("location",{replyTo:a.prompt_message_id,latitude:1,longitude:1}));
    expect((await attempt()).state).toBe("cancelled"); expect((await snapshot()).sessions).toHaveLength(0);
  });
  it("ignores unregistered groups and refuses attendance in private chat",async () => {
    await apply(update("check_in",{chatId:-9999})); await apply(update("check_in",{chatId:7001,chatType:"private"}));
    expect(await scalar("select count(*)::int as result from staffing_attempts")).toBe(0);
  });
  it("requires a matching schedule and protects against overlapping schedules",async () => {
    await apply(update("check_in",{userId:7002}));
    expect(await scalar("select count(*)::int as result from staffing_attempts")).toBe(0);
    await expect(manage("shift",{staff_id:alice,store_id:storeB,label:"Conflict",starts_at:new Date().toISOString(),ends_at:new Date(Date.now()+1000000).toISOString()})).rejects.toThrow("overlaps");
  });
  it("supports concurrent people without sharing their verification evidence",async () => {
    await manage("shift",{staff_id:bob,store_id:storeA,label:"Middle",starts_at:new Date(Date.now()-300000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
    await Promise.all([start("check_in",7001),start("check_in",7002)]);
    let a=await attempt(7001); let b=await attempt(7002);
    await apply(update("location",{userId:7001,replyTo:b.prompt_message_id,latitude:1,longitude:1})); expect((await attempt(7001)).state).toBe("location");
    await apply(update("location",{userId:7001,replyTo:a.prompt_message_id,latitude:1,longitude:1}));
    await apply(update("location",{userId:7002,replyTo:b.prompt_message_id,latitude:2,longitude:2})); await deliverAll();
    a=await attempt(7001); b=await attempt(7002);
    await Promise.all([apply(update("photo",{userId:7001,replyTo:a.prompt_message_id,fileId:"alice"})),apply(update("photo",{userId:7002,replyTo:b.prompt_message_id,fileId:"bob"}))]);
    expect(await scalar("select count(*)::int as result from staffing_sessions")).toBe(2);
    expect(await scalar("select photo_file_id as result from staffing_attempts where staff_id=$1 and state='completed'",[alice])).toBe("alice");
  });
  it("keeps region data, write actions and evidence isolated",async () => {
    await complete(); const a=await snapshot(managerA,false); const b=await snapshot(managerB,false);
    expect(a.stores.map(s=>s.id)).toEqual([storeA]); expect(b.stores.map(s=>s.id)).toEqual([storeB]); expect(b.sessions).toHaveLength(0);
    await expect(manage("staff",{code:"BAD",full_name:"Wrong region",home_store_id:storeB},managerA,false)).rejects.toThrow("FORBIDDEN");
    await expect(manage("region",{name:"Unauthorized"},managerA,false)).rejects.toThrow("FORBIDDEN");
    expect(await scalar("select staffing_evidence($1,false,$2,null) as result",[managerB,a.sessions[0].id])).toEqual([]);
    await db.query("delete from staffing_manager_regions where user_id=$1",[managerA]);
    expect((await snapshot(managerA,false)).sessions).toHaveLength(0);
  });
  it("allows a global admin to schedule cross-region work without exposing the guest roster",async () => {
    await db.query("delete from staffing_shifts where id=$1",[shift]);
    await manage("shift",{staff_id:alice,store_id:storeB,label:"Temporary",starts_at:new Date(Date.now()-300000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString()});
    await complete("check_in",7001,-1002);
    const destination=await snapshot(managerB,false);
    expect(destination.sessions).toHaveLength(1); expect(destination.staff.map(s=>s.id)).not.toContain(alice);
    expect((await snapshot(managerA,false)).sessions).toHaveLength(0);
  });
  it("checks out an open overnight shift even when its scheduled end has passed",async () => {
    await db.query("update staffing_shifts set starts_at=now()-interval '23 hours',ends_at=now()-interval '1 hour' where id=$1",[shift]);
    await db.query("insert into staffing_sessions(shift_id,staff_id,check_in_at) values($1,$2,now()-interval '22 hours')",[shift,alice]);
    await complete("check_out"); expect((await snapshot()).sessions[0].check_out_at).not.toBeNull();
  });
  it("links once through a private invitation and never accepts group onboarding",async () => {
    await db.query("update staffing_staff set telegram_user_id=null where id=$1",[bob]);
    const token="c".repeat(48); await manage("invite",{staff_id:bob,token_hash:invitationHash(token)});
    await apply(update("start",{userId:9001,tokenHash:invitationHash(token)}));
    expect(await scalar("select telegram_user_id as result from staffing_staff where id=$1",[bob])).toBeNull();
    await apply(update("start",{userId:9001,chatId:9001,chatType:"private",tokenHash:invitationHash(token)}));
    expect(Number(await scalar("select telegram_user_id as result from staffing_staff where id=$1",[bob]))).toBe(9001);
    await apply(update("start",{userId:9002,chatId:9002,chatType:"private",tokenHash:invitationHash(token)}));
    expect(Number(await scalar("select telegram_user_id as result from staffing_staff where id=$1",[bob]))).toBe(9001);
  });
  it("stores corrections and coworker reports without overwriting original events",async () => {
    await complete(); const session=(await snapshot()).sessions[0]; const original=session.check_in_at;
    await apply(update("report",{userId:7002,attemptId:session.id})); await apply(update("report",{userId:7002,attemptId:session.id}));
    expect((await snapshot(managerA,false)).reports).toHaveLength(1); expect((await snapshot()).sessions[0].check_in_at).toBe(original);
    const corrected=new Date(Date.parse(original)-60000).toISOString();
    await expect(manage("correction",{session_id:session.id,check_in_at:corrected,reason:"Verified"},managerB,false)).rejects.toThrow("FORBIDDEN");
    await manage("correction",{session_id:session.id,check_in_at:corrected,reason:"Verified against camera"},managerA,false);
    const changed=(await snapshot()).sessions[0]; expect(changed.check_in_at).toBe(original); expect(Date.parse(changed.corrected_in_at!)).toBe(Date.parse(corrected));
    expect(await scalar("select count(*)::int as result from staffing_events")).toBe(1);
    const report=(await snapshot()).reports[0]; await manage("resolve_report",{report_id:report.id,reason:"Reviewed with manager"},managerA,false);
    expect((await snapshot()).reports).toHaveLength(0);
  });
  it("rejects direct anonymous/authenticated RPC and table access",async () => {
    expect(await scalar("select has_function_privilege('anon','staffing_apply_update(jsonb)','execute') as result")).toBe(false);
    expect(await scalar("select has_function_privilege('authenticated','staffing_manage(uuid,boolean,text,jsonb)','execute') as result")).toBe(false);
    expect(await scalar("select has_table_privilege('authenticated','staffing_staff','select') as result")).toBe(false);
    expect(await scalar("select has_function_privilege('service_role','staffing_apply_update(jsonb)','execute') as result")).toBe(true);
    await db.exec("set role service_role");
    try { expect((await snapshot(managerA,false)).stores).toHaveLength(1); }
    finally { await db.exec("reset role"); }
  });
});

describe("Lambda -> database -> Telegram transport", () => {
  it("rejects malformed authenticated JSON without a database mutation or Telegram call",async()=>{
    vi.stubEnv("STAFFING_TELEGRAM_BOT_TOKEN","test-token");vi.stubEnv("STAFFING_TELEGRAM_BOT_USERNAME","staffing_bot");vi.stubEnv("STAFFING_TELEGRAM_WEBHOOK_SECRET","test-secret");vi.stubEnv("SUPABASE_URL","http://localhost:9999");vi.stubEnv("SUPABASE_SECRET_KEY","test-secret");
    const rpc=vi.fn(),send=vi.fn();transport.rpc=rpc;vi.stubGlobal("fetch",send);
    for(const body of["null","[]",'"manager"',"{}",'{"update_id":-1}'])expect((await handler({body,headers:{"X-Telegram-Bot-Api-Secret-Token":"test-secret"}})).statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it("authenticates webhooks, commits once and delivers a group confirmation",async () => {
    vi.stubEnv("STAFFING_TELEGRAM_WEBHOOK_SECRET","test-secret"); vi.stubEnv("STAFFING_TELEGRAM_BOT_TOKEN","test-token"); vi.stubEnv("STAFFING_TELEGRAM_BOT_USERNAME","staffing_bot"); vi.stubEnv("SUPABASE_URL","https://local.invalid"); vi.stubEnv("SUPABASE_SECRET_KEY","test-key");
    transport.rpc=async(name:string,args:Record<string,unknown>={})=>{
      try {
        if(name==="staffing_apply_update") {await rows("select staffing_apply_update($1::jsonb)",[JSON.stringify(args.p_update)]);return {data:null,error:null};}
        if(name==="staffing_claim_outbox") return {data:await rows("select * from staffing_claim_outbox()"),error:null};
        if(name==="staffing_deliver_outbox") {await rows("select staffing_deliver_outbox($1,$2)",[args.p_id,args.p_message_id]);return {data:null,error:null};}
        throw new Error("Unexpected RPC");
      }catch(error){return {data:null,error};}
    };
    const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({ok:true,result:{message_id:++messageId}}),{status:200})); vi.stubGlobal("fetch",send);
    const body=JSON.stringify({update_id:1,message:{message_id:100,date:Math.floor(Date.now()/1000),chat:{id:-1001,type:"supergroup"},from:{id:7001},text:"/masuk@staffing_bot"}});
    expect((await handler({body,headers:{}})).statusCode).toBe(401); expect(send).not.toHaveBeenCalled();
    const event={body,headers:{"X-Telegram-Bot-Api-Secret-Token":"test-secret"}};
    expect((await handler(event)).statusCode).toBe(200); expect(send).toHaveBeenCalledTimes(1);
    const payload=JSON.parse(send.mock.calls[0][1]?.body as string || "{}"); expect(payload.chat_id).toBe(-1001); expect(payload.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^sf:c:/);
    expect((await handler(event)).statusCode).toBe(200); expect(send).toHaveBeenCalledTimes(1);
    async function webhook(u: object) { expect((await handler({body:JSON.stringify(u),headers:event.headers})).statusCode).toBe(200); }
    const chat={id:-1001,type:"supergroup"}; const from={id:7001};
    let updateId=1;
    async function evidenceFlow(kind: string) {
      if(kind==="/pulang") await webhook({update_id:++updateId,message:{message_id:++messageId,date:Math.floor(Date.now()/1000),chat,from,text:kind+"@staffing_bot"}});
      let a=await attempt();
      await webhook({update_id:++updateId,callback_query:{id:"callback-"+updateId,from,message:{message_id:a.prompt_message_id,date:Math.floor(Date.now()/1000),chat,from:{id:999,is_bot:true}},data:"sf:c:"+a.id}});
      a=await attempt(); expect(a.state).toBe("location");
      await webhook({update_id:++updateId,message:{message_id:++messageId,date:Math.floor(Date.now()/1000),chat,from,reply_to_message:{message_id:a.prompt_message_id},location:{latitude:-6.9,longitude:107.7}}});
      a=await attempt(); expect(a.state).toBe("photo");
      await webhook({update_id:++updateId,message:{message_id:++messageId,date:Math.floor(Date.now()/1000),chat,from,reply_to_message:{message_id:a.prompt_message_id},photo:[{file_id:"photo",file_unique_id:"unique",width:800,height:600}]}});
      expect((await attempt()).state).toBe("completed");
    }
    await evidenceFlow("/masuk");
    expect((await snapshot(managerA,false)).sessions).toHaveLength(1);
    await evidenceFlow("/pulang");
    expect((await snapshot(managerA,false)).sessions[0].check_out_at).not.toBeNull();
  });
});
