import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = "supabase/migrations/";
const migrations = [
  "20261107180000_staffing_attendance.sql",
  "20261107193000_staffing_weekly_schedule.sql",
  "20261107203000_staffing_operations_payroll.sql",
  "20261107220000_staffing_create_staff.sql",
  "20261108003000_staffing_review_replacement.sql",
  "20261108100000_staffing_telegram_workflows.sql",
  "20261109090000_staffing_group_management.sql",
];
const sql = (file: string) => readFileSync(directory + file, "utf8");
const preflight = readFileSync("supabase/checks/staffing-production-preflight.sql", "utf8");
async function baseline() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;alter default privileges in schema public grant select on tables to service_role;grant usage on schema public to service_role;");
  await db.exec(readFileSync("supabase/schema.sql", "utf8"));
  await db.exec("grant usage on schema public to service_role; grant select on stores,app_users to service_role;");
  return db;
}
async function legacyState(db: PGlite) {
  const rows: Record<string, unknown> = {};
  for (const table of ["stores", "app_users", "integration_credentials", "pos_transactions", "pos_transaction_items", "sync_runs"]) {
    rows[table] = (await db.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`)).rows;
  }
  const columns = (await db.query(`select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) as default_value,c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and left(c.relname,9)<>'staffing_' and c.relkind in('r','v')
    and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)).rows;
  const constraints = (await db.query(`select co.conname,co.conrelid::regclass::text as relation,pg_get_constraintdef(co.oid) as definition
    from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and left(c.relname,9)<>'staffing_' and co.conname<>'app_users_role_check'
    order by relation,co.conname`)).rows;
  const indexes = (await db.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' and left(tablename,9)<>'staffing_' order by tablename,indexname")).rows;
  return { rows, columns, constraints, indexes };
}
async function report(db: PGlite) {
  const results = await db.exec(preflight);
  return results.flatMap(result => result.rows).find(row => "staffing_preflight" in row)!.staffing_preflight as {
    read_only: string; required_columns: { ok: boolean }[]; existing_staffing_relations: unknown[];
    single_column_id_primary_keys: Record<string, boolean>; cli_history_present: boolean;
  };
}
let db: PGlite;
let before: Awaited<ReturnType<typeof legacyState>>;
let initialReport: Awaited<ReturnType<typeof report>>;
beforeAll(async () => {
  db = await baseline();
  await db.exec(`insert into stores(id,name,time_zone,utc_offset) values('00000000-0000-0000-0000-000000000001','Existing POS store','Asia/Jakarta','+07:00');
    insert into app_users(username,normalized_username,password_hash) values('admin','admin','local-test-placeholder');
    insert into integration_credentials(store_id,refresh_token) values('00000000-0000-0000-0000-000000000001','local-placeholder');
    insert into pos_transactions(store_id,transaction_code,receipt_number,business_date,business_hour,occurred_at,grand_total)
      values('00000000-0000-0000-0000-000000000001','EXISTING',1,'2026-11-01',8,'2026-11-01T01:00:00Z',25000);
    insert into pos_transaction_items(store_id,transaction_code,line_number,item_code,item_name,quantity,gross_sales)
      values('00000000-0000-0000-0000-000000000001','EXISTING',1,'COFFEE','Coffee',1,25000);
    insert into sync_runs(store_id,business_date,trigger,status) values('00000000-0000-0000-0000-000000000001','2026-11-01','test','success');`);
  initialReport = await report(db);
  before = await legacyState(db);
  for (const file of migrations) await db.exec(sql(file));
}, 30000);
afterAll(async () => { await db?.close(); });

describe("staffing rollout against an existing POS database", () => {
  it("applies all seven migrations in dependency order without changing POS data, columns, indexes or legacy constraints", async () => {
    expect(await legacyState(db)).toEqual(before);
    expect((await db.query<{ definition: string }>("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='app_users'::regclass and conname='app_users_role_check'")).rows[0].definition).toContain("manager");
  });
  it("runs the catalog preflight read-only before and after migration", async () => {
    expect(initialReport.read_only).toBe("on");
    expect(initialReport.required_columns.every(column => column.ok)).toBe(true);
    expect(Object.values(initialReport.single_column_id_primary_keys).every(Boolean)).toBe(true);
    expect(initialReport.existing_staffing_relations).toEqual([]);
    const installed = await report(db);
    expect(installed.read_only).toBe("on");
    expect(installed.existing_staffing_relations.length).toBeGreaterThan(20);
    expect(await legacyState(db)).toEqual(before);
  });
  it("keeps every staffing function and table inaccessible to end-user database roles", async () => {
    const functions = (await db.query<{ name: string; anon: boolean; authenticated: boolean; service: boolean }>(`select p.oid::regprocedure::text as name,
      has_function_privilege('anon',p.oid,'execute') as anon,has_function_privilege('authenticated',p.oid,'execute') as authenticated,
      has_function_privilege('service_role',p.oid,'execute') as service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,9)='staffing_'`)).rows;
    expect(functions.length).toBeGreaterThan(30);
    expect(functions.filter(f => f.anon || f.authenticated || !f.service)).toEqual([]);
    const tables = (await db.query<{ name: string; rls: boolean; anon: boolean; authenticated: boolean }>(`select c.relname as name,c.relrowsecurity as rls,
      has_table_privilege('anon',c.oid,'select,insert,update,delete') as anon,
      has_table_privilege('authenticated',c.oid,'select,insert,update,delete') as authenticated
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and left(c.relname,9)='staffing_'`)).rows;
    expect(tables.filter(t => !t.rls || t.anon || t.authenticated)).toEqual([]);
  });
  it("rejects replays and rolls each failed migration back rather than partially modifying the schema", async () => {
    for (const file of migrations) {
      await expect(db.exec(sql(file))).rejects.toThrow();
      await db.exec("rollback");
      expect(await legacyState(db)).toEqual(before);
    }
    const installed = await report(db);
    expect(installed.required_columns.every(column => column.ok)).toBe(true);
    expect((await db.query<{ installed: boolean }>("select to_regprocedure('staffing_decide_shift(uuid,boolean,uuid,text,text)') is not null as installed")).rows[0].installed).toBe(true);
  });
  it("uses sortable, unique Staffing timestamps in dependency order", async () => {
    const sorted = readdirSync(directory).filter(file => file.includes("staffing")).sort();
    expect(sorted).toEqual(migrations);
    expect(sorted.every(file => /^\d{14}_/.test(file))).toBe(true);
    const isolated = await baseline();
    try { await expect(isolated.exec(sql(sorted[1]))).rejects.toThrow(/staffing_shifts/); }
    finally { await isolated.exec("rollback"); await isolated.close(); }
  }, 30000);
  it("rolls back the first migration if production contains an incompatible database role", async () => {
    const isolated = await baseline();
    try {
      await isolated.exec("alter table app_users drop constraint app_users_role_check; alter table app_users add constraint app_users_role_check check(role in('admin','super_admin')); insert into app_users(username,normalized_username,password_hash,role) values('owner','owner','local-test-placeholder','super_admin');");
      await expect(isolated.exec(sql(migrations[0]))).rejects.toThrow(/STAFFING_ROLE_CONFLICT/);
      await isolated.exec("rollback");
      expect((await isolated.query<{ relation: string | null }>("select to_regclass('staffing_regions') as relation")).rows[0].relation).toBeNull();
      expect((await isolated.query<{ role: string }>("select role from app_users")).rows[0].role).toBe("super_admin");
    } finally { await isolated.close(); }
  }, 30000);
  it("rejects extra role constraints and missing service grants before changing authentication", async () => {
    const isolated = await baseline();
    try {
      await isolated.exec("alter table app_users add constraint another_role_rule check(role='admin')");
      await expect(isolated.exec(sql(migrations[0]))).rejects.toThrow("STAFFING_ROLE_CONSTRAINT_CONFLICT");
      await isolated.exec("rollback;alter table app_users drop constraint another_role_rule;revoke select on stores from service_role");
      await expect(isolated.exec(sql(migrations[0]))).rejects.toThrow("STAFFING_SERVICE_GRANT_MISSING");
      await isolated.exec("rollback");
      expect((await isolated.query<{ relation: string | null }>("select to_regclass('staffing_regions') as relation")).rows[0].relation).toBeNull();
    } finally { await isolated.close(); }
  }, 30000);

  it("exports history as ordered JSON without modifying it", async () => {
    await db.exec("create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text);insert into supabase_migrations.schema_migrations values('20261107193000','staffing_weekly_schedule'),('20261107180000','staffing_attendance')");
    const results = await db.exec(readFileSync("supabase/checks/staffing-migration-history.sql", "utf8"));
    const history = results.flatMap(result => result.rows).find(row => "migration_history" in row)!.migration_history;
    expect(history).toEqual([{ version: "20261107180000", name: "staffing_attendance" }, { version: "20261107193000", name: "staffing_weekly_schedule" }]);
    expect((await db.query<{ count: number }>("select count(*)::int as count from supabase_migrations.schema_migrations")).rows[0].count).toBe(2);
  });

  it("accepts a real fresh-database catalog export for manual first-install planning", () => {
    const directory = mkdtempSync(join(tmpdir(), "staffing-catalog-"));
    try {
      const file = join(directory, "preflight.json"); writeFileSync(file, JSON.stringify(initialReport));
      const result = spawnSync(process.execPath, ["scripts/staffing-migrations.mjs", "--manual", "--preflight", file], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout); expect(plan.pending).toHaveLength(7); expect(plan.preflightAccepted).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
