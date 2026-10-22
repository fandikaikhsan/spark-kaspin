import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { ItemError } from "@/lib/items/model";
const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, list: vi.fn(), save: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/receiving/service", () => ({ listReceivings: mocks.list, saveReceiving: mocks.save }));
import { GET, POST } from "@/app/api/receiving/route";
const secret = process.env.AUTH_SESSION_SECRET;
const input = { id: "00000000-0000-4000-8000-000000000001", storeId: "00000000-0000-4000-8000-000000000002", receivedBy: "Andi Salsa", lines: [{ itemId: "BEEF", quantity: 10, itemUpdatedAt: "2026-10-22T12:00:00.123456Z" }] };
const request = (body: unknown) => new Request("http://localhost/api/receiving", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.cookie = undefined; process.env.AUTH_SESSION_SECRET = "receiving-test-secret"; mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue({ id: input.id, replayed: false }); });
afterEach(() => { if (secret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = secret; });
describe("Receiving protected API", () => {
  it.each([undefined, "employee", "staff", "viewer"])("denies access to %s under the current dashboard login", async (role) => {
    if (role) mocks.cookie = await createSessionToken({ userId: "staff", username: "staff", role: role as "admin" });
    expect((await GET(new Request("http://localhost/api/receiving"))).status).toBe(401);
    expect((await POST(request(input))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"] as const)("allows %s, audits the signed-in user, and strips client-controlled units/time/prices", async (role) => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role });
    const get = await GET(new Request(`http://localhost/api/receiving?store=${input.storeId}`));
    expect(get.status).toBe(200); expect(mocks.list).toHaveBeenCalledWith(input.storeId);
    expect((await POST(request({ ...input, submittedBy: "spoofed", receivedAt: "2000-01-01", lines: input.lines.map((line) => ({ ...line, uom: "kg", price: 100 })) }))).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(input, "manager");
    mocks.save.mockResolvedValueOnce({ id: input.id, replayed: true });
    expect((await POST(request(input))).status).toBe(200);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects malformed entries before writes and surfaces stale catalog conflicts", async () => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role: "admin" });
    expect((await POST(request({ ...input, lines: [] }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/receiving", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/receiving?store=bad"))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
    mocks.save.mockRejectedValueOnce(new ItemError("Item unit changed", 409));
    expect((await POST(request(input))).status).toBe(409);
  });
});
