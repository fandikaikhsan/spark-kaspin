import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { ItemError } from "@/lib/items/model";
const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, list: vi.fn(), items: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/bases/service", () => ({ listBases: mocks.list, saveBase: mocks.save, deleteBase: mocks.remove }));
vi.mock("@/lib/items/service", () => ({ listItems: mocks.items }));
import { GET, POST } from "@/app/api/bases/route";
import { PATCH, DELETE } from "@/app/api/bases/[id]/route";
const secret = process.env.AUTH_SESSION_SECRET;
const input = { id: "BASE-001", name: "Carbonara", baseUom: "porsi", yieldQuantity: 22, ingredients: [{ itemId: "MILK", quantity: 1000, uom: "ml" }] };
const context = { params: Promise.resolve({ id: "BASE-001" }) };
const request = (method: string, body?: unknown) => new Request("http://localhost/api/bases", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { vi.resetAllMocks(); mocks.cookie = undefined; process.env.AUTH_SESSION_SECRET = "bases-api-test-secret"; mocks.list.mockResolvedValue([]); mocks.items.mockResolvedValue([]); mocks.save.mockResolvedValue("BASE-001"); });
afterEach(() => { if (secret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = secret; });
describe("Bases API access and atomic saves", () => {
  it.each([undefined, "employee", "staff", "viewer"])("blocks all operations for %s", async (role) => {
    if (role) mocks.cookie = await createSessionToken({ userId: "staff", username: "staff", role: role as "admin" });
    expect((await GET()).status).toBe(401); expect((await POST(request("POST", input))).status).toBe(401);
    expect((await PATCH(request("PATCH", input), context)).status).toBe(401); expect((await DELETE(request("DELETE"), context)).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.items).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"] as const)("allows global CRUD for %s", async (role) => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role });
    expect(await (await GET()).json()).toEqual({ bases: [], items: [] });
    expect((await POST(request("POST", input))).status).toBe(201);
    expect((await PATCH(request("PATCH", input), context)).status).toBe(200);
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect(mocks.save).toHaveBeenCalledWith(null, input); expect(mocks.save).toHaveBeenCalledWith("BASE-001", input);
  });
  it("validates input before writes and preserves conflict errors", async () => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role: "admin" });
    expect((await POST(request("POST", { ...input, ingredients: [] }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/bases", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await PATCH(request("PATCH", input), { params: Promise.resolve({ id: "bad/id" }) })).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.save.mockRejectedValueOnce(new ItemError("Duplicate ID", 409)); expect((await POST(request("POST", input))).status).toBe(409);
    mocks.remove.mockRejectedValueOnce(new ItemError("Referenced base", 409)); expect((await DELETE(request("DELETE"), context)).status).toBe(409);
  });
});
