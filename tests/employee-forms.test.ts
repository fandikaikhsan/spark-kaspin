import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { isEmployeeFormRequest } from "@/lib/operations/access";
import { parseStockEntry } from "@/lib/stock-opname/model";
import { COUNTERS, STOCK_FIELDS } from "@/lib/stock-opname/template";
const mocks = vi.hoisted(() => ({ stock: vi.fn(), receiving: vi.fn() }));
vi.mock("@/lib/stock-opname/service", () => ({ saveAutomaticStockOpname: mocks.stock }));
vi.mock("@/lib/receiving/service", () => ({ saveReceiving: mocks.receiving }));
import { POST as stockPost } from "@/app/api/staff/stock-opname/route";
import { POST as receivingPost } from "@/app/api/staff/receiving/route";
import { middleware } from "@/middleware";
import { ItemError } from "@/lib/items/model";
const id = "00000000-0000-4000-8000-000000000001", storeId = "00000000-0000-4000-8000-000000000002";
const stock = () => ({ id, storeId, countedBy: COUNTERS[0], answers: Object.fromEntries(STOCK_FIELDS.map((field) => [field.key, field.section === "restock" ? false : 0])) });
const receiving = () => ({ id, storeId, receivedBy: COUNTERS[0], lines: [{ itemId: "BEEF", quantity: 2.5, uom: "kg", itemUpdatedAt: "2026-10-24T12:00:00.123456Z" }] });
function request(path: string, body: unknown, headers: Record<string,string> = {}) {
  return new Request(`https://dashboard.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://dashboard.example", ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => { vi.resetAllMocks(); mocks.stock.mockResolvedValue({ id, replayed: false }); mocks.receiving.mockResolvedValue({ id, replayed: false }); });
describe("Employee-only public surface", () => {
  it("opens only the exact two form pages and POST endpoints", async () => {
    for (const path of ["/staff/stock-opname", "/staff/receiving"]) {
      expect(isEmployeeFormRequest(path, "GET")).toBe(true);
      expect(isEmployeeFormRequest(path, "HEAD")).toBe(true);
      const response = await middleware(new NextRequest(`https://dashboard.example${path}`));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    for (const path of ["/api/staff/stock-opname", "/api/staff/receiving"]) {
      expect(isEmployeeFormRequest(path, "POST")).toBe(true);
      expect(isEmployeeFormRequest(path, "GET")).toBe(false);
      for (const method of ["GET", "PUT", "PATCH", "DELETE"]) expect((await middleware(new NextRequest(`https://dashboard.example${path}`, { method }))).status).toBe(401);
    }
  });
  it.each(["/", "/items", "/bases", "/products", "/settings", "/transactions", "/stock-opname", "/receiving", "/staff", "/staff/receiving/history"])("keeps %s behind login", async (path) => {
    const response = await middleware(new NextRequest(`https://dashboard.example${path}`));
    expect(response.status).toBe(307); expect(response.headers.get("location")).toContain("/login?next=");
  });
  it.each(["/api/items", "/api/products", "/api/stock-opname", "/api/receiving", "/api/cogs", "/api/users", "/api/staff/receiving/history"])("keeps %s private", async (path) => {
    for (const method of ["GET", "POST"]) expect((await middleware(new NextRequest(`https://dashboard.example${path}`, { method }))).status).toBe(401);
  });
});
describe("Employee submissions without a login", () => {
  it("saves all 40 stock answers with an automatic time and fixed provenance", async () => {
    const body = stock();
    const response = await stockPost(request("/api/staff/stock-opname", { ...body, submittedBy: "owner", countDate: "1999-01-01", countedAt: "1999-01-01T00:00:00Z", lines: [{ quantity: 999 }] }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id, replayed: false });
    expect(mocks.stock).toHaveBeenCalledWith(body, "employee-form");
    expect(parseStockEntry({ ...body, countedAt: "spoofed" })).not.toHaveProperty("countedAt");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    mocks.stock.mockResolvedValueOnce({ id, replayed: true });
    expect((await stockPost(request("/api/staff/stock-opname", body))).status).toBe(200);
  });
  it("accepts numeric receiving quantities and strips prices, timestamps and conversions", async () => {
    const body = receiving();
    const response = await receivingPost(request("/api/staff/receiving", { ...body, submittedBy: "owner", receivedAt: "1999-01-01", lines: body.lines.map((line) => ({ ...line, price: 500, receivedConversion: 10000 })) }));
    expect(response.status).toBe(201); expect(mocks.receiving).toHaveBeenCalledWith(body, "employee-form");
    mocks.receiving.mockResolvedValueOnce({ id, replayed: true });
    expect((await receivingPost(request("/api/staff/receiving", body))).status).toBe(200);
  });
  it("rejects invalid answers, employees, items and amounts before any write", async () => {
    expect((await stockPost(request("/api/staff/stock-opname", { ...stock(), answers: {} }))).status).toBe(400);
    expect((await stockPost(request("/api/staff/stock-opname", { ...stock(), countedBy: "Stranger" }))).status).toBe(400);
    expect((await receivingPost(request("/api/staff/receiving", { ...receiving(), lines: [] }))).status).toBe(400);
    expect((await receivingPost(request("/api/staff/receiving", { ...receiving(), lines: [{ ...receiving().lines[0], quantity: "2 packs" }] }))).status).toBe(400);
    expect(mocks.stock).not.toHaveBeenCalled(); expect(mocks.receiving).not.toHaveBeenCalled();
  });
  it("rejects cross-origin, non-JSON and oversized submissions", async () => {
    expect((await stockPost(request("/api/staff/stock-opname", stock(), { origin: "https://other.example" }))).status).toBe(403);
    expect((await receivingPost(request("/api/staff/receiving", receiving(), { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await stockPost(request("/api/staff/stock-opname", { junk: "x".repeat(128001) }))).status).toBe(413);
    expect(mocks.stock).not.toHaveBeenCalled(); expect(mocks.receiving).not.toHaveBeenCalled();
  });
  it("does not expose database diagnostics or direct employees to private history", async () => {
    mocks.stock.mockRejectedValueOnce(new Error("sensitive database diagnostics"));
    let response = await stockPost(request("/api/staff/stock-opname", stock()));
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("sensitive");
    mocks.receiving.mockRejectedValueOnce(new ItemError("Periksa riwayat", 409));
    response = await receivingPost(request("/api/staff/receiving", receiving()));
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain("riwayat");
  });
});
