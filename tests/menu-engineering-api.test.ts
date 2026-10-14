import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { EngineeringError } from "@/lib/menu-engineering/model";

const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, load: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/menu-engineering/service", () => ({ loadCatalog: mocks.load, saveItem: mocks.save, deleteItem: mocks.remove }));
import { GET, POST } from "@/app/api/menu-engineering/route";
import { PATCH, DELETE } from "@/app/api/menu-engineering/[id]/route";

const secret = process.env.AUTH_SESSION_SECRET;
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const item = { type: "raw_material", code: "MILK", name: "Milk", purchasePrice: 20000, purchaseQuantity: 1, uom: "l" };
function request(method: string, body?: unknown) { return new Request(`http://localhost/api/menu-engineering?store=${id}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); }
beforeEach(() => { vi.clearAllMocks(); mocks.cookie = undefined; process.env.AUTH_SESSION_SECRET = "menu-api-test-secret"; mocks.load.mockResolvedValue({ items: [], categories: [] }); mocks.save.mockResolvedValue(id); });
afterEach(() => { if (secret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = secret; });

describe("menu engineering API authorization and validation", () => {
  it("requires authentication on every read and mutation", async () => {
    expect((await GET(request("GET"))).status).toBe(401);
    expect((await POST(request("POST", { storeId: id, item }))).status).toBe(401);
    expect((await PATCH(request("PATCH", { storeId: id, item }), context)).status).toBe(401);
    expect((await DELETE(request("DELETE"), context)).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"] as const)("allows CRUD for %s", async (role) => {
    mocks.cookie = await createSessionToken({ userId: "user", username: "admin", role });
    expect((await GET(request("GET"))).status).toBe(200);
    expect((await POST(request("POST", { storeId: id, item }))).status).toBe(201);
    expect((await PATCH(request("PATCH", { storeId: id, item }), context)).status).toBe(200);
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect(mocks.save).toHaveBeenCalledWith(id, null, expect.objectContaining({ code: "MILK", ingredients: [] }));
  });
  it("rejects signed sessions with insufficient roles", async () => {
    mocks.cookie = await createSessionToken({ userId: "viewer", username: "viewer", role: "viewer" as "admin" });
    expect((await POST(request("POST", { storeId: id, item }))).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON, store IDs and required values before saving", async () => {
    mocks.cookie = await createSessionToken({ userId: "user", username: "admin", role: "admin" });
    expect((await POST(new Request("http://localhost/api/menu-engineering", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(request("POST", { storeId: "invalid", item }))).status).toBe(400);
    expect((await POST(request("POST", { storeId: id, item: { ...item, purchaseQuantity: 0 } }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("preserves conflict and not-found errors from atomic writes", async () => {
    mocks.cookie = await createSessionToken({ userId: "user", username: "admin", role: "admin" });
    mocks.save.mockRejectedValueOnce(new EngineeringError("Duplicate material ID", 409));
    expect((await POST(request("POST", { storeId: id, item }))).status).toBe(409);
    mocks.remove.mockRejectedValueOnce(new EngineeringError("Item not found", 404));
    expect((await DELETE(request("DELETE"), context)).status).toBe(404);
  });
});
