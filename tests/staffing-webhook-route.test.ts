import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const calls = vi.hoisted(() => ({ webhook: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/staffing/webhook", () => ({ handleStaffingWebhook: calls.webhook }));
vi.mock("@/lib/auth/current-user", () => ({ currentSession: calls.session, allowedPath: () => true }));
import { POST } from "@/app/api/telegram/staffing/route";
import { middleware } from "@/middleware";
const url = "https://dashboard.example/api/telegram/staffing";
function request(body = "{}", secret = "staff-secret", type = "application/json") {
  return new Request(url, { method: "POST", headers: { "content-type": type, "x-telegram-bot-api-secret-token": secret }, body });
}
beforeEach(() => { vi.stubEnv("STAFFING_TELEGRAM_WEBHOOK_SECRET", "staff-secret"); calls.webhook.mockReset().mockResolvedValue({ statusCode: 200, body: "OK" }); calls.session.mockReset().mockResolvedValue(null); });
afterEach(() => { vi.unstubAllEnvs(); });
describe("Telegram webhook on the existing Next.js dashboard", () => {
  it("uses header authentication independently from dashboard login", async () => {
    expect((await POST(request())).status).toBe(200); expect(calls.webhook).toHaveBeenCalledOnce();
    expect((await POST(request("{}", "wrong"))).status).toBe(401); expect(calls.webhook).toHaveBeenCalledOnce();
    vi.stubEnv("STAFFING_TELEGRAM_WEBHOOK_SECRET", ""); expect((await POST(request())).status).toBe(401);
  });
  it("constructs a webhook context and never promotes flush or actor fields into transport flags", async () => {
    const body = JSON.stringify({ flush: true, requestContext: null, p_bootstrap: true });
    await POST(request(body)); const forwarded = calls.webhook.mock.calls[0][0];
    expect(forwarded.body).toBe(body); expect(forwarded).not.toHaveProperty("flush");
    expect(forwarded.requestContext).toEqual({ http: { method: "POST", path: "/api/telegram/staffing" } });
  });
  it("rejects non-JSON and oversized updates before reaching the webhook processor", async () => {
    expect((await POST(request("{}", "staff-secret", "text/plain"))).status).toBe(415);
    expect((await POST(request("x".repeat(1024 * 1024 + 1)))).status).toBe(413); expect(calls.webhook).not.toHaveBeenCalled();
  });
  it("preserves retryable failure status and disables response caching", async () => {
    calls.webhook.mockResolvedValue({ statusCode: 503, body: "Unavailable" }); const response = await POST(request());
    expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("exempts only the exact webhook path from session middleware", async () => {
    calls.session.mockRejectedValue(new Error("Account database unavailable"));
    expect((await middleware(new NextRequest(url))).status).toBe(200); expect(calls.session).not.toHaveBeenCalled();
    calls.session.mockResolvedValue(null);
    for (const path of ["/api/staffing", "/api/telegram/staffing/admin", "/api/users"]) expect((await middleware(new NextRequest("https://dashboard.example" + path))).status).toBe(401);
  });
});
