import { describe, expect, it } from "vitest";
import { isLocalDockerEndpoint, migrationBody, productionEnvironment, snapshotCounter } from "../scripts/local-supabase-utils.mjs";

const env = { SUPABASE_URL: "https://projectref.supabase.co", SUPABASE_PRODUCTION_DB_URL: "postgresql://postgres.projectref:test%40password@aws-0-region.pooler.supabase.com:5432/postgres" };
describe("production-to-local database safeguards", () => {
  it("requires a matching project, PostgreSQL credentials, session pooler, and TLS", () => {
    expect(productionEnvironment(env)).toMatchObject({ PGPASSWORD: "test@password", PGUSER: "postgres.projectref", PGSSLMODE: "require", PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=0" });
    for (const uri of ["https://example.com", "postgresql://postgres@host/postgres", "postgresql://postgres:pass@localhost/postgres", "postgresql://postgres:pass@[::1]/postgres", env.SUPABASE_PRODUCTION_DB_URL.replace("5432", "6543"), env.SUPABASE_PRODUCTION_DB_URL.replace("postgres.projectref", "postgres.other"), env.SUPABASE_PRODUCTION_DB_URL + "?sslmode=disable"]) {
      expect(() => productionEnvironment({ ...env, SUPABASE_PRODUCTION_DB_URL: uri })).toThrow();
    }
  });
  it("rejects remote Docker daemons and remote Windows named pipes", () => {
    expect(isLocalDockerEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine")).toBe(true);
    expect(isLocalDockerEndpoint("unix:///var/run/docker.sock")).toBe(true);
    for (const endpoint of ["tcp://remote:2375", "ssh://remote", "npipe:////remote/pipe/docker_engine", "unix://remote/path", null]) expect(isLocalDockerEndpoint(endpoint)).toBe(false);
  });
  it("counts COPY records without exposing their contents and handles quoted table names", () => {
    const counter = snapshotCounter();
    ["-- archive", "COPY public.stores (id, name) FROM stdin;", "1\tSarkop", "2\tSecond", "\\.", 'COPY public."Quoted Table" (name) FROM stdin;', "escaped\\nnewline", "\\.", "COPY public.empty (id) FROM stdin;", "\\."].forEach(counter.line);
    expect(counter.result()).toEqual({ "public.stores": 2, "public.Quoted Table": 1, "public.empty": 0 });
  });
  it("rejects incomplete archives and strips only the outer migration transaction", () => {
    const counter = snapshotCounter();
    counter.line("COPY public.stores (id) FROM stdin;"); counter.line("1");
    expect(() => counter.result()).toThrow("complete");
    expect(migrationBody("begin;\ncreate function x() returns void as $$ begin; return; end; $$ language plpgsql;\ncommit;\n")).toContain("$$ begin; return; end;");
    expect(migrationBody("begin;\nselect 1;\ncommit;\n").trim()).toBe("select 1;");
  });
});
