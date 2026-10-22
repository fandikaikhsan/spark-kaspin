import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { ItemError } from "@/lib/items/model";
import { COUNTERS, STOCK_FIELDS } from "@/lib/stock-opname/template";
const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, list: vi.fn(), save: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/stock-opname/service", () => ({ listStockOpnames: mocks.list, saveStockOpname: mocks.save }));
import { GET, POST } from "@/app/api/stock-opname/route";
const secret = process.env.AUTH_SESSION_SECRET;
const input = { id: "00000000-0000-4000-8000-000000000001", storeId: "00000000-0000-4000-8000-000000000002", countDate: "2026-10-22", countedBy: COUNTERS[0], answers: Object.fromEntries(STOCK_FIELDS.map((field) => [field.key, field.section === "restock" ? false : 0])) };
const request = (body: unknown) => new Request("http://localhost/api/stock-opname", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.cookie = undefined; process.env.AUTH_SESSION_SECRET = "stock-opname-test-secret"; mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue({ id: input.id, replayed: false }); });
afterEach(() => { if (secret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = secret; });
describe("Stock opname protected API", () => {
  it.each([undefined, "employee", "staff", "viewer"])("denies access to %s for now", async (role) => {
    if (role) mocks.cookie = await createSessionToken({ userId: "staff", username: "staff", role: role as "admin" });
    expect((await GET(new Request("http://localhost/api/stock-opname"))).status).toBe(401);
    expect((await POST(request(input))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"] as const)("allows %s and records authenticated submitter, separate from selected counter", async (role) => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role });
    const get = await GET(new Request(`http://localhost/api/stock-opname?store=${input.storeId}`));
    expect(get.status).toBe(200); expect(mocks.list).toHaveBeenCalledWith(input.storeId);
    expect((await POST(request({ ...input, submittedBy: "spoofed" }))).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(input, "manager");
    mocks.save.mockResolvedValueOnce({ id: input.id, replayed: true });
    expect((await POST(request(input))).status).toBe(200);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects missing answers before writes and reports conflicts without overwriting", async () => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role: "admin" });
    expect((await POST(request({ ...input, answers: {} }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/stock-opname", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/stock-opname?store=bad"))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
    mocks.save.mockRejectedValueOnce(new ItemError("Different answers", 409));
    expect((await POST(request(input))).status).toBe(409);
  });
});
