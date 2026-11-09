import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
const script = resolve("scripts/staffing-telegram-setup.mjs");
const url = "https://dashboard.example/api/telegram/staffing";
function run(args: string[], overrides: Record<string, string> = {}, existing = "") {
  const directory = mkdtempSync(join(tmpdir(), "staffing-setup-")), captured = join(directory, "calls.json"), mock = join(directory, "mock.mjs");
  writeFileSync(mock, `import{writeFileSync}from'node:fs';const calls=[];globalThis.fetch=async(input,init)=>{const method=new URL(input).pathname.split('/').at(-1);calls.push({method,payload:JSON.parse(init.body)});writeFileSync(${JSON.stringify(captured)},JSON.stringify(calls));const result=method==='getMe'?{is_bot:true,username:'staffing_bot'}:method==='getWebhookInfo'?{url:${JSON.stringify(existing)}}:true;return new Response(JSON.stringify({ok:true,result}),{status:200});};`);
  try {
    const result = spawnSync(process.execPath, ["--import", mock, script, ...args], { encoding: "utf8", env: {
      ...process.env, STAFFING_TELEGRAM_WEBHOOK_URL: url, STAFFING_TELEGRAM_BOT_USERNAME: "staffing_bot", STAFFING_TELEGRAM_BOT_TOKEN: "200:staff-token", STAFFING_TELEGRAM_WEBHOOK_SECRET: "staffing-secret-for-test-1234567890", TELEGRAM_BOT_TOKEN: "100:pos-token", TELEGRAM_WEBHOOK_SECRET: "pos-secret-for-test-123456789012345", ...overrides,
    } });
    let calls: { method: string; payload: Record<string, unknown> }[] = []; try { calls = JSON.parse(readFileSync(captured, "utf8")); } catch { /* No API request occurred. */ }
    return { ...result, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
describe("operator webhook setup for the dashboard webhook", () => {
  it("dry-runs the /staffing endpoint without any Telegram request", () => {
    const result = run([]); expect(result.status).toBe(0); expect(result.calls).toEqual([]); expect(result.stdout).toContain(url);
  });
  it("rejects the non-dashboard URL unless a standalone deployment is explicit", () => {
    expect(run(["--url", "https://example.lambda-url.eu-central-1.on.aws/"]).status).toBe(1);
    expect(run(["--url", "https://example.lambda-url.eu-central-1.on.aws/", "--standalone"]).status).toBe(0);
  });
  it("rejects shared bot identity or secrets before contacting Telegram", () => {
    const cases: Record<string, string>[] = [{ STAFFING_TELEGRAM_BOT_TOKEN: "100:rotated-token" }, { STAFFING_TELEGRAM_WEBHOOK_SECRET: "pos-secret-for-test-123456789012345" }];
    for (const overrides of cases) {
      const result = run(["--apply"], overrides); expect(result.status).toBe(1); expect(result.calls).toEqual([]); expect(result.stderr).not.toContain("rotated-token");
    }
  });
  it("installs private/group menus and the secret-protected path only after identity verification", () => {
    const result = run(["--apply"]); expect(result.status).toBe(0);
    expect(result.calls.map(c => c.method)).toEqual(["getMe", "getWebhookInfo", "setMyCommands", "setMyCommands", "setWebhook"]);
    expect(result.calls[2].payload.scope).toEqual({ type: "all_group_chats" }); expect(result.calls[3].payload.scope).toEqual({ type: "all_private_chats" });
    expect(result.calls[4].payload).toMatchObject({ url, secret_token: "staffing-secret-for-test-1234567890", drop_pending_updates: false, allowed_updates: ["message", "callback_query"] });
    expect(result.stdout).not.toContain("staff-token"); expect(result.stdout).not.toContain("staffing-secret-for-test");
  });
  it("leaves a different webhook unchanged without an explicit replacement flag", () => {
    const result = run(["--apply"], {}, "https://other.example/staffing"); expect(result.status).toBe(1);
    expect(result.calls.map(c => c.method)).toEqual(["getMe", "getWebhookInfo"]);
  });
});
