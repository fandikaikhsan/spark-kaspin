import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
let db: PGlite;
const store = "10000000-0000-0000-0000-000000000001";
const other = "10000000-0000-0000-0000-000000000002";
const manager = "20000000-0000-0000-0000-000000000001";
async function result<T>(sql: string, args: unknown[] = []) { return (await db.query<{ result: T }>(sql, args)).rows[0].result; }
async function create(data: object, actor: string | null = null, bootstrap = true) {
  return result<{ id: string; code: string }>("select staffing_create_staff($1,$2,$3::jsonb)as result", [actor, bootstrap, JSON.stringify(data)]);
}
const payload = () => ({ full_name: "New staff", home_store_id: store, initial_leave: "", ceiling: "", client_id: randomUUID() });
beforeAll(async () => {
  db = new PGlite(); await db.exec("create role anon;create role authenticated;create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;");
  for (const file of ["supabase/schema.sql", "supabase/migrations/20261107180000_staffing_attendance.sql", "supabase/migrations/20261107193000_staffing_weekly_schedule.sql", "supabase/migrations/20261107203000_staffing_operations_payroll.sql", "supabase/migrations/20261107220000_staffing_create_staff.sql"]) await db.exec(readFileSync(file, "utf8"));
  await db.query("insert into stores(id,name,time_zone,utc_offset)values($1,'Home','Asia/Jakarta','+07:00'),($2,'Other','Asia/Makassar','+08:00')", [store, other]);
  await db.query("insert into app_users(id,username,normalized_username,password_hash,role)values($1,'manager','manager','test','manager')", [manager]);
  const region = await result<string>("insert into staffing_regions(name)values('Home')returning id as result");
  await db.query("insert into staffing_store_regions(store_id,region_id)values($1,$2),($3,$2)", [store, region, other]);
  await db.query("insert into staffing_manager_regions values($1,$2)", [manager, region]);
}, 30000);
afterAll(async () => { await db.close(); });
describe("atomic staff creation", () => {
  it("generates unique codes and initializes an explicitly known zero balance", async () => {
    const first = await create(payload()), second = await create(payload()); expect(first.code).toMatch(/^STAF-\d+$/); expect(first.code).not.toBe(second.code);
    expect(await result("select staffing_staff_money($1)as result", [first.id])).toMatchObject({ leave_balance: 0, ceiling: 0, available: 0 });
  });
  it("persists initial leave and the fixed ceiling together", async () => {
    const staff = await create({ ...payload(), initial_leave: 2.5, ceiling: 500000, code: "ignored-client-code" }, manager, false);
    expect(staff.code).not.toBe("ignored-client-code"); expect(await result("select staffing_staff_money($1)as result", [staff.id])).toMatchObject({ leave_balance: 2.5, ceiling: 500000, outstanding: 0 });
  });
  it("deduplicates retries without crediting the opening leave twice", async () => {
    const data = { ...payload(), initial_leave: 12 }; const first = await create(data), second = await create(data); expect(second.id).toBe(first.id);
    expect(await result<number>("select count(*)::int as result from staffing_leave_entries where staff_id=$1", [first.id])).toBe(1);
    await expect(create({ ...data, initial_leave: 24 })).rejects.toThrow("data lain");
  });
  it("rejects invalid opening balances without creating a partial staff record", async () => {
    const before = await result<number>("select count(*)::int as result from staffing_staff");
    for (const invalid of [{ initial_leave: -1 }, { initial_leave: .1 }, { ceiling: .5 }, { ceiling: -1 }, { full_name: "  " }]) await expect(create({ ...payload(), ...invalid })).rejects.toThrow();
    expect(await result<number>("select count(*)::int as result from staffing_staff")).toBe(before);
  });
  it("enforces region, active store and server-only privileges", async () => {
    await db.query("delete from staffing_store_regions where store_id=$1", [other]);
    await expect(create({ ...payload(), home_store_id: other }, manager, false)).rejects.toThrow("FORBIDDEN");
    await db.query("update stores set active=false where id=$1", [other]);
    await expect(create({ ...payload(), home_store_id: other })).rejects.toThrow("FORBIDDEN");
    expect(await result("select has_function_privilege('anon','staffing_create_staff(uuid,boolean,jsonb)','execute')as result")).toBe(false);
  });
});
