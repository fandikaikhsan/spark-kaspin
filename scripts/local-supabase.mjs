import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalDockerEndpoint, migrationBody, productionEnvironment, snapshotCounter } from "./local-supabase-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
const project = "spark-kaspin-local";
const container = `supabase_db_${project}`;
const network = `${project}-loopback`;
const backups = path.join(root, "supabase", "backups");
const cli = path.join(root, "node_modules", "supabase", "dist", "supabase.js");
const migrations = ["20261013_menu_engineering.sql", "20261022_items.sql", "20261022_item_details.sql", "20261022_bases.sql", "20261022_products.sql", "20261022_stock_opname.sql", "20261022_receiving.sql"]
  .map((file) => path.join(root, "supabase", "migrations", file));
const dockerCandidates = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
  "C:/Program Files/Docker/Docker/resources/bin/docker.exe",
];
const docker = dockerCandidates.find((candidate) => candidate && existsSync(candidate)) || "docker";
if (docker !== "docker") process.env.PATH = path.dirname(docker) + path.delimiter + process.env.PATH;

function redact(text) {
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length > 5 && /PASSWORD|SECRET|TOKEN|DB_URL|SERVICE_ROLE_KEY/.test(key)) text = text.split(value).join("[redacted]");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL redacted]");
}
async function run(binary, args, { env = {}, input, label = "Command", lines, stdoutFile, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const output = stdoutFile ? pipeline(child.stdout, createWriteStream(stdoutFile)) : null;
    output?.catch(() => {});
    if (stdoutFile) { /* Data is streamed directly into the ignored snapshot file. */ }
    else if (lines) createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", lines);
    else child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4 * 1024 * 1024); });
    child.on("error", (error) => reject(new Error(`${label}: ${error.code === "ENOENT" ? "required executable is not installed" : error.message}`)));
    child.on("close", async (code) => {
      try {
      if (output) await output;
      if (code === 0 || allowFailure) resolve({ stdout, stderr, code });
      else {
        await mkdir(backups, { recursive: true });
        let diagnostics = stderr || stdout;
        for (const value of Object.values(env)) if (typeof value === "string" && value.length > 5) diagnostics = diagnostics.split(value).join("[redacted]");
        await writeFile(path.join(backups, "last-error.log"), redact(diagnostics));
        reject(new Error(`${label} failed (exit ${code}). Details: supabase/backups/last-error.log`));
      }
      } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
function supabase(args, options) { return run(process.execPath, [cli, ...args], { label: "Supabase CLI", ...options }); }
async function requireLocalDocker() {
  const endpoint = process.env.DOCKER_CONTEXT
    ? JSON.parse((await run(docker, ["context", "inspect", process.env.DOCKER_CONTEXT, "--format", "{{json .Endpoints.docker.Host}}"], { label: "Read Docker context" })).stdout.trim())
    : process.env.DOCKER_HOST || JSON.parse((await run(docker, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], { label: "Read Docker context" })).stdout.trim());
  if (!isLocalDockerEndpoint(endpoint)) throw new Error("This script requires a local Docker daemon (local named pipe or Unix socket).");
  // Pin the verified endpoint for every child command, even if the active context changes.
  process.env.DOCKER_HOST = endpoint;
  delete process.env.DOCKER_CONTEXT;
  await run(docker, ["info", "--format", "{{.ServerVersion}}"], { label: "Docker Desktop is not running; open it and wait for the Linux engine" });
}
async function assertLocalDatabase() {
  await requireLocalDocker();
  const result = await run(docker, ["inspect", container, "--format", "{{json .Config.Labels}}"], { label: "Local Supabase database is not running; run npm run local:start" });
  const labels = JSON.parse(result.stdout.trim());
  if (labels["com.supabase.cli.project"] !== project) throw new Error("Database container does not belong to this local Supabase project.");
}
const localEnv = { PGHOST: "127.0.0.1", PGPORT: "5432", PGDATABASE: "postgres", PGUSER: "postgres", PGPASSWORD: "postgres", PGSSLMODE: "disable" };
function execDatabase(args, { env = localEnv, ...options } = {}) {
  return run(docker, ["exec", "-i", ...Object.keys(env).flatMap((key) => ["--env", key]), container, ...args], { env, label: "Local PostgreSQL command", ...options });
}
async function localStatus() {
  const output = await supabase(["status", "--output", "json"]);
  try { return JSON.parse(output.stdout); } catch { throw new Error("Could not parse local Supabase status."); }
}
async function checkSource() {
  const env = productionEnvironment(process.env);
  const uri = new URL(process.env.SUPABASE_PRODUCTION_DB_URL);
  uri.password = "";
  uri.searchParams.set("sslmode", env.PGSSLMODE);
  const result = await supabase(["db", "query", "--db-url", uri.href, "--output-format", "json",
    "SELECT current_setting('server_version') AS server_version, pg_database_size(current_database()) AS database_bytes;"], {
    env: { ...env, SUPABASE_DB_PASSWORD: env.PGPASSWORD }, label: "Read-only production connectivity check",
  });
  const payload = JSON.parse(result.stdout);
  console.table(payload.rows);
}
async function start() {
  await requireLocalDocker();
  const inspected = await run(docker, ["network", "inspect", network], { allowFailure: true });
  if (inspected.code === 0) {
    if (JSON.parse(inspected.stdout)[0].Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1") throw new Error("Local network must bind published ports to 127.0.0.1.");
  } else await run(docker, ["network", "create", "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network], { label: "Create local-only Docker network" });
  console.log("Starting local Supabase; the first run downloads container images.");
  await supabase(["start", "--network-id", network]);
  await assertLocalDatabase();
  console.log("Local Supabase is running. Studio: http://127.0.0.1:54323; API: http://127.0.0.1:54321");
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
async function archiveRowCounts(archivePath) {
  const counter = snapshotCounter();
  await execDatabase(["pg_restore", "--data-only", "--file=-", archivePath], {
    label: "Count records in production snapshot", lines: counter.line,
  });
  return counter.result();
}
async function localRowCounts() {
  const sql = `CREATE TEMP TABLE clone_counts(name text,n bigint);
DO $$ DECLARE t record; BEGIN
FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
EXECUTE format('INSERT INTO clone_counts SELECT %L,count(*) FROM public.%I', 'public.' || t.tablename, t.tablename);
END LOOP; END $$;
SELECT coalesce(jsonb_object_agg(name,n),'{}'::jsonb) FROM clone_counts;`;
  const result = await execDatabase(["psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1"], { input: sql, label: "Verify local row counts" });
  return JSON.parse(result.stdout.trim());
}
async function copyToContainer(source, destination) {
  await run(docker, ["cp", source, `${container}:${destination}`], { label: "Copy local SQL to database container" });
}
const privateGrants = `
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM public, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
NOTIFY pgrst, 'reload schema';
`;
async function writeLocalEnvironment() {
  const status = await localStatus();
  const apiUrl = status.API_URL || status.api_url;
  const key = status.SERVICE_ROLE_KEY || status.SECRET_KEY || status.service_role_key || status.secret_key;
  if (!apiUrl || !key || !["127.0.0.1", "localhost"].includes(new URL(apiUrl).hostname)) throw new Error("Local API URL or service role key is missing from Supabase status.");
  const file = path.join(root, ".env.local");
  let current = existsSync(file) ? await readFile(file, "utf8") : "";
  if (current) await copyFile(file, path.join(backups, `env-local-${stamp()}.bak`));
  current = current.split(/\r?\n/).filter((line) => !/^\s*(?:SUPABASE_URL|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=/.test(line)).join("\n").trim();
  await writeFile(file, `${current ? current + "\n\n" : ""}# Local Supabase (generated by npm run local:clone)\nSUPABASE_URL=${JSON.stringify(apiUrl)}\nSUPABASE_SECRET_KEY=${JSON.stringify(key)}\n`);
  console.log("Wrote .env.local with local Supabase credentials. Production .env values are preserved.");
}
async function applicationMigrations() {
  const sources = await Promise.all(migrations.map((file) => readFile(file, "utf8")));
  return sources.map(migrationBody).join("\n\n");
}
async function clone() {
  const sourceEnv = productionEnvironment(process.env);
  await assertLocalDatabase();
  await mkdir(backups, { recursive: true });
  const directory = path.join(backups, `production-${stamp()}`);
  await mkdir(directory);
  console.log("Exporting a consistent, read-only snapshot of the production public schema and data…");
  await execDatabase(["pg_dump", "--format=custom", "--schema=public", "--no-owner", "--no-privileges", "--file=/tmp/spark-production.dump"], { env: sourceEnv, label: "Read-only production export" });
  await run(docker, ["cp", `${container}:/tmp/spark-production.dump`, path.join(directory, "production.dump")], { label: "Save production archive" });
  await execDatabase(["pg_restore", "--schema-only", "--no-owner", "--no-privileges", "--file=/tmp/spark-production-schema.sql", "/tmp/spark-production.dump"]);
  await run(docker, ["cp", `${container}:/tmp/spark-production-schema.sql`, path.join(directory, "schema.sql")], { label: "Save production schema" });
  const expected = await archiveRowCounts("/tmp/spark-production.dump");
  await writeFile(path.join(directory, "row-counts.json"), JSON.stringify(expected, null, 2));
  console.log(`Production snapshot saved (${Object.keys(expected).length} tables). Backing up the current local database…`);
  await execDatabase(["pg_dump", "--format=custom", "--schema=public", "--no-owner", "--no-privileges", "--file=/tmp/spark-local-before.dump"], { label: "Back up existing local data" });
  await run(docker, ["cp", `${container}:/tmp/spark-local-before.dump`, path.join(directory, "local-before.dump")], { label: "Save local backup" });
  // PostgreSQL versions differ in whether the archive creates the built-in public schema.
  // Recreate it explicitly and omit only that schema's TOC entry from the restore.
  const toc = await execDatabase(["pg_restore", "--list", "/tmp/spark-production.dump"], { label: "Read archive contents" });
  const restoreList = path.join(directory, "restore.list");
  await writeFile(restoreList, toc.stdout.split(/\r?\n/).filter((line) => !/^\d+; \d+ \d+ SCHEMA - public(?:\s|$)/.test(line)).join("\n"));
  await copyToContainer(restoreList, "/tmp/spark-restore.list");
  await execDatabase(["pg_restore", "--use-list=/tmp/spark-restore.list", "--no-owner", "--no-privileges", "--file=/tmp/spark-restore.sql", "/tmp/spark-production.dump"], { label: "Prepare restore SQL" });
  const patchPath = path.join(directory, "local-migration.sql");
  await writeFile(patchPath, await applicationMigrations() + privateGrants);
  await copyToContainer(patchPath, "/tmp/spark-local-migration.sql");
  console.log("Restoring the snapshot and applying menu engineering to the local database in one transaction…");
  // The destination is a checked, project-labelled local container. No connection argument
  // can redirect this operation to production. The backup above preserves previous local data.
  await execDatabase(["psql", "--no-psqlrc", "--quiet", "--single-transaction", "--set", "ON_ERROR_STOP=1",
    "--command", "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION postgres;", "--file", "/tmp/spark-restore.sql", "--file", "/tmp/spark-local-migration.sql"], { label: "Local database restore and migration" });
  const actual = await localRowCounts();
  for (const [table, count] of Object.entries(expected)) if (actual[table] !== count) throw new Error(`Row count mismatch for ${table}: snapshot ${count}, local ${actual[table]}. Local environment has not been switched.`);
  await writeFile(path.join(directory, "local-row-counts.json"), JSON.stringify(actual, null, 2));
  await writeLocalEnvironment();
  console.table(actual);
  console.log("Clone verified. Restart npm run dev to use the local database.");
}
async function migrate() {
  await assertLocalDatabase();
  await mkdir(backups, { recursive: true });
  const patch = path.join(backups, "local-menu-migration.sql");
  await writeFile(patch, await applicationMigrations() + privateGrants);
  await copyToContainer(patch, "/tmp/spark-local-migration.sql");
  await execDatabase(["psql", "--no-psqlrc", "--quiet", "--single-transaction", "--set", "ON_ERROR_STOP=1", "--file", "/tmp/spark-local-migration.sql"], { label: "Apply local menu engineering migration" });
  console.log("Catalog and recipe migrations applied to the local database.");
}
async function main() {
  switch (process.argv[2]) {
    case "check": {
      productionEnvironment(process.env); console.log("Production connection URI is present and structurally valid (credentials hidden).");
      if (!existsSync(cli)) throw new Error("Install project dependencies first: npm install.");
      await requireLocalDocker(); console.log("Local Docker engine is ready."); break;
    }
    case "start": await start(); break;
    case "source": await checkSource(); break;
    case "clone": await clone(); break;
    case "migrate": await migrate(); break;
    case "stop": await requireLocalDocker(); await supabase(["stop"]); console.log("Local Supabase stopped; database volumes retained."); break;
    case "status": {
      await assertLocalDatabase(); const status = await localStatus();
      console.log(`Studio: ${status.STUDIO_URL || "http://127.0.0.1:54323"}\nAPI: ${status.API_URL || "http://127.0.0.1:54321"}\nPostgreSQL: 127.0.0.1:54322 (database postgres)`); break;
    }
    case "progress": {
      await requireLocalDocker();
      const images = await run(docker, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}} {{.Size}}"], { label: "Read downloaded images" });
      const containers = await run(docker, ["ps", "--all", "--filter", `label=com.supabase.cli.project=${project}`, "--format", "{{.Names}} {{.Status}}"], { label: "Read local container status" });
      console.log(images.stdout.trim() || "Images are still downloading.");
      console.log(containers.stdout.trim() || "No project containers have started yet."); break;
    }
    default: throw new Error("Usage: node scripts/local-supabase.mjs check|source|start|clone|migrate|stop|status|progress");
  }
}
export { assertLocalDatabase, backups, docker, execDatabase, redact, root, run };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
}
