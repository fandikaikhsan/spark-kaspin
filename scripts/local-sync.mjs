import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { assertLocalDatabase, backups, docker, execDatabase, redact, run } from "./local-supabase.mjs";
import { productionEnvironment } from "./local-supabase-utils.mjs";
import { applySnapshotSql, parseSyncOptions, sourceSnapshotSql, stagingSql } from "./local-sync-utils.mjs";

const directory = path.join(backups, "live-transactions");
const lockPath = path.join(directory, "sync.lock");
let stopped = false;
let wake = null;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopped = true; wake?.(); });

async function acquireLock() {
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => {
        const current = JSON.parse(await readFile(lockPath, "utf8"));
        if (current.token === token) await unlink(lockPath);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let current;
      try { current = await readFile(lockPath, "utf8"); }
      catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
      let alive = true;
      try { process.kill(JSON.parse(current).pid, 0); }
      catch (pidError) { if (pidError.code === "ESRCH") alive = false; }
      if (alive) throw new Error("Another local transaction sync is running. Stop it with Ctrl+C in its terminal first.");
      if (await readFile(lockPath, "utf8").catch(() => null) === current) await unlink(lockPath).catch((removeError) => { if (removeError.code !== "ENOENT") throw removeError; });
    }
  }
  throw new Error("Could not acquire the local sync lock. Try again.");
}
async function mirror(sourceEnv, cursor, full) {
  const dataPath = path.join(directory, "latest-data.sql");
  const applyPath = path.join(directory, "latest-apply.sql");
  await execDatabase(["psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1"], {
    env: sourceEnv, input: sourceSnapshotSql(full ? null : cursor), stdoutFile: dataPath,
    label: "Read-only production transaction snapshot",
  });
  if (stopped) return null;
  await writeFile(applyPath, stagingSql());
  await pipeline(createReadStream(dataPath), createWriteStream(applyPath, { flags: "a" }));
  await appendFile(applyPath, applySnapshotSql(full));
  // Recheck the destination immediately before copying/applying each snapshot.
  await assertLocalDatabase();
  // Use the same PATH and pinned local daemon established by assertLocalDatabase.
  await run(docker, ["cp", applyPath, "supabase_db_spark-kaspin-local:/tmp/spark-live-transactions.sql"], { label: "Copy transaction snapshot to local database" });
  const applied = await execDatabase(["psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--single-transaction", "--set", "ON_ERROR_STOP=1", "--file", "/tmp/spark-live-transactions.sql"], { label: "Atomic local transaction mirror" });
  const summary = JSON.parse(applied.stdout.trim());
  await writeFile(path.join(directory, "last-sync.json"), JSON.stringify(summary, null, 2));
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Makassar", dateStyle: "medium", timeStyle: "medium" }).format(new Date(summary.sourceTime));
  console.log(`[${time} WITA] ${summary.mode}: ${summary.transactions} transactions / ${summary.items} items; local totals ${summary.totalTransactions} / ${summary.totalItems}.`);
  return summary;
}
async function main() {
  const options = parseSyncOptions(process.argv.slice(2));
  const sourceEnv = productionEnvironment(process.env);
  const local = parseEnv(await readFile(".env.local", "utf8"));
  if (!["localhost", "127.0.0.1"].includes(new URL(local.SUPABASE_URL).hostname)) throw new Error(".env.local must point to local Supabase before mirroring transactions.");
  await assertLocalDatabase();
  await mkdir(directory, { recursive: true });
  const release = await acquireLock();
  try {
    console.log(options.watch ? `Mirroring production transactions locally every ${options.interval}s. Press Ctrl+C to stop.` : "Backfilling all production transactions into local Supabase…");
    let cursor = null;
    let lastFull = 0;
    do {
      const full = !cursor || Date.now() - lastFull >= 15 * 60 * 1000;
      try {
        const summary = await mirror(sourceEnv, cursor, full);
        if (summary) { cursor = summary.sourceTime; if (full) lastFull = Date.now(); }
      } catch (error) {
        if (!options.watch) throw error;
        console.error(`Sync failed; keeping the last successful data and retrying: ${redact(error.message)}`);
      }
      if (!options.watch || stopped) break;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, options.interval * 1000);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    } while (!stopped);
  } finally { await release(); }
}
main().catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
