export function productionEnvironment(env) {
  const value = env.SUPABASE_PRODUCTION_DB_URL;
  if (!value) throw new Error("Add SUPABASE_PRODUCTION_DB_URL to .env using the production Session pooler connection URI.");
  let url;
  try { url = new URL(value); } catch { throw new Error("SUPABASE_PRODUCTION_DB_URL must be a valid PostgreSQL URI."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password) {
    throw new Error("Production connection URI needs a PostgreSQL protocol, host, username, and database password.");
  }
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error("Production source unexpectedly points to localhost.");
  if (url.port === "6543") throw new Error("Use the Session pooler on port 5432, rather than the transaction pooler on 6543.");
  const username = decodeURIComponent(url.username);
  if (env.SUPABASE_URL) {
    const appHost = new URL(env.SUPABASE_URL).hostname;
    if (appHost.endsWith(".supabase.co")) {
      const ref = appHost.split(".")[0];
      if ((url.hostname.endsWith(".pooler.supabase.com") && username !== `postgres.${ref}`)
        || (url.hostname.startsWith("db.") && url.hostname !== `db.${ref}.supabase.co`)) {
        throw new Error("Production connection URI does not match the Supabase project configured in .env.");
      }
    }
  }
  const sslMode = url.searchParams.get("sslmode") || "require";
  if (!["require", "verify-ca", "verify-full"].includes(sslMode)) throw new Error("Production connections must require TLS (sslmode=require or stronger).");
  return { PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: username,
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || "postgres",
    PGSSLMODE: sslMode, PGCONNECT_TIMEOUT: "20", PGAPPNAME: "spark-local-clone-readonly",
    PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=0" };
}
export function isLocalDockerEndpoint(endpoint) {
  return typeof endpoint === "string" && (/^npipe:\/+[.](?:\/pipe\/)/i.test(endpoint)
    || /^npipe:\/+localhost\/pipe\//i.test(endpoint) || endpoint.startsWith("unix:///"));
}
export function migrationBody(sql) {
  return sql.replace(/^begin;\s*$/im, "").replace(/^commit;\s*$/im, "");
}
export function snapshotCounter() {
  const counts = {};
  let table = null;
  return {
    line(line) {
      if (table !== null) { if (line === "\\.") table = null; else counts[table] += 1; }
      else {
        const match = /^COPY public\.((?:"(?:[^"]|"")*")|(?:[a-z_][a-z0-9_$]*)) \(.+\) FROM stdin;$/.exec(line);
        if (match) {
          const identifier = match[1].startsWith('"') ? match[1].slice(1, -1).replaceAll('""', '"') : match[1];
          table = `public.${identifier}`; counts[table] = 0;
        }
      }
    },
    result() {
      if (table !== null || !Object.keys(counts).length) throw new Error("The archive contains no recognizable, complete public-table data blocks.");
      return counts;
    },
  };
}
