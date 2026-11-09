import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const script = resolve("scripts/staffing-migrations.mjs");
function run(files: string[], history?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "staffing-migration-plan-"));
  try {
    for (const file of files) writeFileSync(join(directory, file), "-- local test fixture\n");
    const args = [script, "--migrations-dir", directory];
    if (history === undefined) args.push("--staffing-only");
    else { writeFileSync(join(directory, "history.json"), JSON.stringify(history)); args.push("--history", join(directory, "history.json")); }
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    return { status: result.status, data: JSON.parse(result.stdout) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const foundation = "20261107180000_staffing_attendance.sql", weekly = "20261107193000_staffing_weekly_schedule.sql";
describe("read-only Staffing migration plan", () => {
  it("checks sortable Staffing files without claiming remote history validation", () => {
    const result = run([foundation, weekly]); expect(result.status).toBe(0); expect(result.data.historyVerified).toBe(false); expect(result.data.pending).toBeNull();
  });
  it("rejects the old short attendance version and duplicate Staffing versions", () => {
    expect(run(["20261107_staffing_attendance.sql", weekly]).status).toBe(1);
    expect(run([foundation, "20261107180000_staffing_other.sql"]).status).toBe(1);
  });
  it("blocks a full plan on duplicated historical POS versions", () => {
    const result = run([foundation, "20260927_multi_store.sql", "20260927_dashboard_auth.sql"], []);
    expect(result.status).toBe(1); expect(result.data.errors.join(" ")).toContain("Duplicate version 20260927");
  });
  it("rejects missing applied files, old attendance identities and history gaps", () => {
    expect(run([foundation, weekly], [{ version: "20261107", name: "staffing_attendance" }]).status).toBe(1);
    expect(run([foundation, weekly], [{ version: "20261107193000", name: "staffing_weekly_schedule" }]).status).toBe(1);
    expect(run([foundation], [{ version: "20260927000000", name: "missing_baseline" }]).status).toBe(1);
  });
  it("plans only an unapplied suffix and rejects mismatched names or malformed history", () => {
    const result = run([foundation, weekly], [{ version: "20261107180000", name: "staffing_attendance" }]);
    expect(result.status).toBe(0); expect(result.data.pending.map((item: { file: string }) => item.file)).toEqual([weekly]); expect(result.data.migrations[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run([foundation], [{ version: "20261107180000", name: "other" }]).status).toBe(1);
    expect(run([foundation], { arbitrary: "value" }).status).toBe(1);
  });
  it("blocks unexpected POS replay and pending migrations older than applied history", () => {
    const unapplied = run([foundation, "20260927090000_pos_baseline.sql"], []);
    expect(unapplied.status).toBe(1); expect(unapplied.data.errors.join(" ")).toContain("Unapplied non-Staffing");
    const late = run([foundation, "20261110000000_other_feature.sql"], [{ version: "20261110000000", name: "other_feature" }]);
    expect(late.status).toBe(1); expect(late.data.errors.join(" ")).toContain("predates applied version");
  });

});

const catalog = {
  read_only: "on",
  required_columns: ["stores.id", "stores.name", "stores.active", "stores.time_zone", "app_users.id", "app_users.username", "app_users.role", "app_users.active"].map(name => { const [table_name, column_name] = name.split("."); return { table_name, column_name, ok: true }; }),
  single_column_id_primary_keys: { stores: true, app_users: true },
  incompatible_app_user_roles: 0, additional_role_constraints: [],
  service_can_read_dependencies: { stores: true, app_users: true },
  unsupported_store_time_zones: 0, uuid_generator_available: true,
  existing_staffing_relations: [], existing_staffing_functions: [], cli_history_present: false,
};
function manual(preflight: unknown, history?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "staffing-manual-plan-"));
  try {
    for (const file of [foundation, weekly, "20260927_multi_store.sql", "20260927_dashboard_auth.sql"]) writeFileSync(join(directory, file), "-- local fixture\n");
    writeFileSync(join(directory, "preflight.json"), JSON.stringify(preflight));
    const args = [script, "--manual", "--migrations-dir", directory, "--preflight", join(directory, "preflight.json")];
    if (history !== undefined) { writeFileSync(join(directory, "history.json"), JSON.stringify(history)); args.push("--history", join(directory, "history.json")); }
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    return { status: result.status, data: JSON.parse(result.stdout) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
describe("manual SQL Editor rollout plan", () => {
  it("uses the catalog snapshot rather than historical POS versions to plan a first install", () => {
    const result = manual(catalog);
    expect(result.status).toBe(0); expect(result.data.scope).toBe("manual-first-install");
    expect(result.data.pending.map((item: { file: string }) => item.file)).toEqual([foundation, weekly]);
    expect(result.data.databaseAccessed).toBe(false); expect(result.data.historyVerified).toBe(false);
  });
  it("accepts a SQL Editor JSON export and refuses to infer progress from existing objects", () => {
    expect(manual([{ staffing_preflight: catalog }]).status).toBe(0);
    expect(manual({ ...catalog, existing_staffing_relations: [{ name: "staffing_staff" }] }).status).toBe(1);
    expect(manual({ ...catalog, existing_staffing_functions: [{ signature: "staffing_dashboard(uuid,boolean)" }] }).data.pending).toBeNull();
  });
  it("requires complete compatible read-only catalog evidence", () => {
    expect(manual({}).status).toBe(1);
    expect(manual({ ...catalog, read_only: "off" }).status).toBe(1);
    expect(manual({ ...catalog, required_columns: [] }).status).toBe(1);
    expect(manual({ ...catalog, incompatible_app_user_roles: 1 }).status).toBe(1);
    expect(manual({ ...catalog, additional_role_constraints: ["custom_rule"] }).status).toBe(1);
    expect(manual({ ...catalog, service_can_read_dependencies: { stores: false, app_users: true } }).status).toBe(1);
    expect(manual({ ...catalog, unsupported_store_time_zones: 1 }).status).toBe(1);
  });
  it("does not ignore a CLI history table if one is discovered", () => {
    const snapshot = { ...catalog, cli_history_present: true };
    expect(manual(snapshot).status).toBe(1); expect(manual(snapshot, []).status).toBe(0);
    expect(manual(snapshot, [{ version: "20260927", name: "pos" }]).status).toBe(1);
    expect(manual(catalog, [{ version: "20260927" }]).status).toBe(1);
  });
});
