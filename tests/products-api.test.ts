import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth/session";
import { ItemError } from "@/lib/items/model";
const mocks = vi.hoisted(() => ({ cookie: undefined as string | undefined, load: vi.fn(), save: vi.fn(), remove: vi.fn(), categories: vi.fn(), category: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/products/service", () => ({ loadProductCatalog: mocks.load, saveProduct: mocks.save, deleteProduct: mocks.remove, listCategories: mocks.categories, createCategory: mocks.category }));
import { GET, POST } from "@/app/api/products/route";
import { PATCH, DELETE } from "@/app/api/products/[id]/route";
import { GET as GET_CATEGORY, POST as POST_CATEGORY } from "@/app/api/categories/route";
const secret = process.env.AUTH_SESSION_SECRET;
const input = { id: "MENU-001", name: "Water", type: "menu", parentProductId: null, categoryId: null, salesPrice: 5000, baseUom: "porsi", yieldQuantity: 1, ingredients: [{ kind: "item", ingredientId: "WATER", quantity: 1, uom: "pcs" }] };
const category = { id: "00000000-0000-4000-8000-000000000001", name: "Drinks" };
const context = { params: Promise.resolve({ id: "MENU-001" }) };
const request = (method: string, body?: unknown) => new Request("http://localhost/api/products", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { vi.resetAllMocks(); mocks.cookie = undefined; process.env.AUTH_SESSION_SECRET = "products-test-secret"; mocks.load.mockResolvedValue({ products: [], items: [], bases: [], categories: [] }); mocks.save.mockResolvedValue("MENU-001"); mocks.categories.mockResolvedValue([category]); mocks.category.mockResolvedValue(category); });
afterEach(() => { if (secret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = secret; });
describe("Products and Categories manager/owner APIs", () => {
  it.each([undefined, "employee", "staff", "viewer"])("denies every operation for %s", async (role) => {
    if (role) mocks.cookie = await createSessionToken({ userId: "staff", username: "staff", role: role as "admin" });
    expect((await GET()).status).toBe(401); expect((await POST(request("POST", input))).status).toBe(401);
    expect((await PATCH(request("PATCH", input), context)).status).toBe(401); expect((await DELETE(request("DELETE"), context)).status).toBe(401);
    expect((await GET_CATEGORY()).status).toBe(401); expect((await POST_CATEGORY(request("POST", { name: "Drinks" }))).status).toBe(401);
    for (const fn of [mocks.load, mocks.save, mocks.remove, mocks.categories, mocks.category]) expect(fn).not.toHaveBeenCalled();
  });
  it.each(["admin", "super_admin"] as const)("allows global product CRUD and inline categories for %s", async (role) => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role });
    expect((await GET()).status).toBe(200); expect((await POST(request("POST", input))).status).toBe(201);
    expect((await PATCH(request("PATCH", input), context)).status).toBe(200); expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect(await (await GET_CATEGORY()).json()).toEqual({ categories: [category] });
    expect(await (await POST_CATEGORY(request("POST", { name: " Drinks " }))).json()).toEqual({ category });
    expect(mocks.category).toHaveBeenCalledWith("Drinks"); expect(mocks.save).toHaveBeenCalledWith(null, input); expect(mocks.save).toHaveBeenCalledWith("MENU-001", input);
  });
  it("rejects malformed requests before writes and preserves reference conflicts", async () => {
    mocks.cookie = await createSessionToken({ userId: "manager", username: "manager", role: "admin" });
    expect((await POST(request("POST", { ...input, ingredients: [] }))).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/products", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await PATCH(request("PATCH", input), { params: Promise.resolve({ id: "bad/id" }) })).status).toBe(400);
    expect((await POST_CATEGORY(request("POST", { name: " " }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.category).not.toHaveBeenCalled();
    mocks.remove.mockRejectedValueOnce(new ItemError("Used by variants", 409)); expect((await DELETE(request("DELETE"), context)).status).toBe(409);
    mocks.save.mockRejectedValueOnce(new ItemError("Missing product", 404)); expect((await PATCH(request("PATCH", input), context)).status).toBe(404);
  });
});
