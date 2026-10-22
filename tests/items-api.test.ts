import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { ItemError } from "@/lib/items/model";
import { canManageItems } from "@/lib/items/auth";

const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, list: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/items/service", () => ({ listItems: mocks.list, saveItem: mocks.save, deleteItem: mocks.remove }));
import { GET, POST } from "@/app/api/items/route";
import { PATCH, DELETE } from "@/app/api/items/[id]/route";

const secret = process.env.AUTH_SESSION_SECRET;
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const item = { name: "Milk", baseUom: "ml", purchasePrice: 24000, purchaseQuantity: 1, purchaseUnitName: "l", purchaseConversion: 1000 };
function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/items", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.cookie = undefined; process.env.AUTH_SESSION_SECRET = "items-api-test-secret";
  mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue(id);
});
afterEach(() => { if (secret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = secret; });

describe("Items access is restricted to managers and owners", () => {
  it("requires authentication for reads and every mutation", async () => {
    expect((await GET()).status).toBe(401);
    expect((await POST(request("POST", item))).status).toBe(401);
    expect((await PATCH(request("PATCH", item), context)).status).toBe(401);
    expect((await DELETE(request("DELETE"), context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each(["admin", "super_admin"] as const)("allows global CRUD for existing %s role without a store ID", async (role) => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role });
    expect((await GET()).status).toBe(200);
    expect((await POST(request("POST", item))).status).toBe(201);
    expect((await PATCH(request("PATCH", item), context)).status).toBe(200);
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect(mocks.save).toHaveBeenCalledWith(null, { ...item, supplier: "" });
    expect(mocks.save).toHaveBeenCalledWith(id, { ...item, supplier: "" });
  });

  it.each(["employee", "staff", "viewer"])("denies %s even with a correctly signed unsupported role", async (role) => {
    expect(canManageItems(role)).toBe(false);
    mocks.cookie = await createSessionToken({ userId: "employee", username: "employee", role: role as "admin" });
    expect((await GET()).status).toBe(401);
    expect((await POST(request("POST", item))).status).toBe(401);
    expect((await PATCH(request("PATCH", item), context)).status).toBe(401);
    expect((await DELETE(request("DELETE"), context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("validates JSON, IDs and conversions before any database write", async () => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role: "admin" });
    expect((await POST(new Request("http://localhost/api/items", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(request("POST", { ...item, purchaseConversion: 1 }))).status).toBe(400);
    expect((await PATCH(request("PATCH", item), { params: Promise.resolve({ id: "invalid/id" }) })).status).toBe(400);
    expect((await DELETE(request("DELETE"), { params: Promise.resolve({ id: "invalid/id" }) })).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("preserves reference conflicts and missing item errors", async () => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role: "admin" });
    mocks.remove.mockRejectedValueOnce(new ItemError("This item is used by a recipe", 409));
    expect((await DELETE(request("DELETE"), context)).status).toBe(409);
    mocks.save.mockRejectedValueOnce(new ItemError("Item not found", 404));
    expect((await PATCH(request("PATCH", item), context)).status).toBe(404);
  });
});
