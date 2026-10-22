import { describe, expect, it } from "vitest";
import { applySnapshotSql, parseSyncOptions, sourceSnapshotSql, stagingSql } from "../scripts/local-sync-utils.mjs";

describe("production transaction mirroring", () => {
  it("requires explicit watch mode and bounds its polling interval", () => {
    expect(parseSyncOptions([])).toEqual({ watch: false, interval: 30 });
    expect(parseSyncOptions(["--watch", "--interval", "60"])).toEqual({ watch: true, interval: 60 });
    for (const args of [["--interval"], ["--interval", "0"], ["--interval", "3.5"], ["--interval", "3601"], ["--remote"]]) expect(() => parseSyncOptions(args)).toThrow();
  });
  it("exports all transaction data from a consistent read-only source transaction", () => {
    const sql = sourceSnapshotSql();
    expect(sql).toContain("REPEATABLE READ READ ONLY");
    expect(sql).toContain("FROM public.pos_transactions t WHERE true");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP)\b/i);
    expect(sql).not.toMatch(/integration_credentials|engineering_items|app_users/);
    expect(sql).toContain("TO STDOUT");
  });
  it("uses the source clock, overlapping cursor and store-local dates for transactions and their full item lines", () => {
    const sql = sourceSnapshotSql("2026-10-15T12:00:00.000Z");
    expect(sql).toContain("transaction_timestamp()");
    expect(sql.match(/synced_at >= '2026-10-15T11:59:00.000Z'/g)).toHaveLength(2);
    expect(sql.match(/AT TIME ZONE s.time_zone/g)).toHaveLength(2);
    expect(() => sourceSnapshotSql("invalid'; DELETE FROM stores;--")).toThrow();
  });
  it("replaces lines for changed transactions while keeping unmodified historical transactions", () => {
    const sql = applySnapshotSql(false);
    expect(sql).toContain("USING mirror_transactions");
    expect(sql).not.toContain("DELETE FROM public.pos_transactions;");
    expect(sql).toContain("ON CONFLICT (store_id,transaction_code) DO UPDATE");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
  });
  it("fully reconciles sales deletions and preserves recipes, credentials, users and existing audit rows", () => {
    const sql = applySnapshotSql(true);
    expect(sql).toContain("DELETE FROM public.pos_transaction_items;");
    expect(sql).toContain("DELETE FROM public.pos_transactions;");
    expect(sql).not.toMatch(/engineering_|integration_credentials|app_users|UPDATE public\.stores/);
    expect(sql).toContain("DELETE FROM public.sync_runs WHERE trigger='local-production-mirror'");
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im); // The caller supplies the single enclosing transaction.
    expect(stagingSql()).toContain("CREATE TEMP TABLE mirror_transactions");
  });
});
