import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const storeA = "10000000-0000-0000-0000-000000000001", storeB = "10000000-0000-0000-0000-000000000002";
const admin = "20000000-0000-0000-0000-000000000001", manager = "20000000-0000-0000-0000-000000000002";
const migrationFiles = readdirSync("supabase/migrations").filter(file => file.includes("staffing_")).sort();
async function setup(excludeLast = false) {
  const instance = new PGlite();
  await instance.exec("create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;");
  await instance.exec(readFileSync("supabase/schema.sql", "utf8"));
  for (const file of excludeLast ? migrationFiles.slice(0, -1) : migrationFiles) await instance.exec(readFileSync("supabase/migrations/" + file, "utf8"));
  return instance;
}
let db: PGlite;
async function save(chat: number, previous: number | null = null, actor: string | null = admin, store = storeA, note = "Pindah ke grup operasional baru") {
  return (await db.query("select staffing_save_group($1,false,$2,$3,$4,$5) as value", [actor, store, chat, previous, note])).rows[0];
}
beforeAll(async () => { db = await setup(); }, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate stores,app_users,staffing_regions,staffing_audit,staffing_outbox cascade");
  await db.query("insert into stores(id,name,time_zone,utc_offset)values($1,'Store A','Asia/Jakarta','+07:00'),($2,'Store B','Asia/Makassar','+08:00')", [storeA, storeB]);
  await db.query("insert into app_users(id,username,normalized_username,password_hash,role)values($1,'admin','admin','test','admin'),($2,'manager','manager','test','manager')", [admin, manager]);
  await db.exec("insert into staffing_regions(name)values('Region A');insert into staffing_store_regions(store_id,region_id)select id,(select id from staffing_regions limit 1)from stores");
});

describe("admin Telegram group mapping", () => {
  it("creates one mapping per store and rejects another store's existing chat ID", async () => {
    await save(-1001);
    await expect(save(-1002)).rejects.toThrow("sudah terdaftar");
    await expect(save(-1001, null, admin, storeB)).rejects.toThrow(/duplicate/);
    await expect(db.query("insert into staffing_groups(chat_id,store_id)values(-1002,$1)", [storeA])).rejects.toThrow(/duplicate/);
  });
  it("permits only an active admin, including when the caller supplies a manager ID", async () => {
    await expect(save(-1001, null, manager)).rejects.toThrow("FORBIDDEN");
    await db.query("update app_users set active=false where id=$1", [admin]);
    await expect(save(-1001)).rejects.toThrow("FORBIDDEN");
  });
  it("requires an active store with a region and a valid Telegram ID", async () => {
    await db.query("delete from staffing_store_regions where store_id=$1", [storeA]);
    await expect(save(-1001)).rejects.toThrow("region");
    await db.query("update stores set active=false where id=$1", [storeB]);
    await expect(save(-1001, null, admin, storeB)).rejects.toThrow("store aktif");
    await expect(save(0)).rejects.toThrow("angka negatif");
    await expect(save(-9007199254740992)).rejects.toThrow("angka negatif");
  });
  it("replaces the selected mapping with a recorded reason and rejects stale edits", async () => {
    await save(-1001); await save(-1002, -1001);
    expect((await db.query<{ chat_id: number }>("select chat_id from staffing_groups")).rows[0].chat_id).toBe(-1002);
    const audit = (await db.query<{ details: { previous_chat_id: number; chat_id: number; note: string } }>("select details from staffing_audit where action='group_mapping' order by id desc limit 1")).rows[0].details;
    expect(audit).toMatchObject({ previous_chat_id: -1001, chat_id: -1002, note: "Pindah ke grup operasional baru" });
    await expect(save(-1003, -1001)).rejects.toThrow("sudah berubah");
    await expect(save(-1003, -1002, admin, storeA, "")).rejects.toThrow("alasan");
  });
  it("treats an unchanged mapping as a no-op without another audit record", async () => {
    await save(-1001); await save(-1001, -1001);
    expect((await db.query<{ count: number }>("select count(*)::int as count from staffing_audit where action='group_mapping'")).rows[0].count).toBe(1);
  });
  it("refuses relinking while messages or shift selection flows are outstanding", async () => {
    await save(-1001);
    await db.exec("insert into staffing_outbox(payload)values('{\"chat_id\":-1001,\"text\":\"Pending message\"}')");
    await expect(save(-1002, -1001)).rejects.toThrow("belum selesai");
    await db.exec("update staffing_outbox set delivered_at=now();insert into staffing_swap_flows(user_id,chat_id,step)values(7001,-1001,'mode')");
    await expect(save(-1002, -1001)).rejects.toThrow("belum selesai");
    await db.exec("update staffing_swap_flows set expires_at=now()-interval '1 second'");
    await save(-1002, -1001);
  });
  it("refuses relinking during attendance verification and retains original evidence", async () => {
    await save(-1001);
    await db.query("insert into staffing_staff(code,full_name,home_store_id)values('TEST','Test staff',$1)", [storeA]);
    await db.query("insert into staffing_shifts(staff_id,store_id,label,starts_at,ends_at)select id,$1,'Opening',now(),now()+interval '8 hours'from staffing_staff", [storeA]);
    await db.exec("insert into staffing_attempts(staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id)select staff_id,id,-1001,'check_in','confirmation',now(),100 from staffing_shifts");
    await expect(save(-1002, -1001)).rejects.toThrow("belum selesai");
    await db.exec("update staffing_attempts set state='completed',completed_at=now()");
    await save(-1002, -1001);
    expect((await db.query<{ chat_id: number }>("select chat_id from staffing_attempts")).rows[0].chat_id).toBe(-1001);
  });
  it("prevents future messages from being queued to a replaced group while preserving private notifications", async () => {
    await save(-1001); await save(-1002, -1001);
    await db.exec("insert into staffing_outbox(payload)values('{\"chat_id\":-1001,\"text\":\"Old group\"}'),('{\"chat_id\":7001,\"text\":\"Personal result\"}')");
    const messages = (await db.query<{ chat: number }>("select (payload->>'chat_id')::int as chat from staffing_outbox")).rows;
    expect(messages).toEqual([{ chat: 7001 }]);
  });
  it("does not expose mapping changes to anon or authenticated database roles", async () => {
    for (const role of ["anon", "authenticated"]) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'staffing_save_group(uuid,boolean,uuid,bigint,bigint,text)','execute')as allowed", [role])).rows[0].allowed).toBe(false);
  });
  it("stops migration on duplicate historical store mappings without deleting either group", async () => {
    const isolated = await setup(true);
    try {
      await isolated.exec("insert into stores(name,time_zone,utc_offset)values('Historical store','Asia/Jakarta','+07:00');insert into staffing_groups(chat_id,store_id)select -1001,id from stores;insert into staffing_groups(chat_id,store_id)select -1002,id from stores");
      await expect(isolated.exec(readFileSync("supabase/migrations/" + migrationFiles.at(-1), "utf8"))).rejects.toThrow("STAFFING_GROUP_DUPLICATE");
      await isolated.exec("rollback");
      expect((await isolated.query<{ count: number }>("select count(*)::int as count from staffing_groups")).rows[0].count).toBe(2);
    } finally { await isolated.close(); }
  }, 30000);
});
