import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ retry: vi.fn(), stores: vi.fn(), create: vi.fn(), sync: vi.fn(), complete: vi.fn(), cleanup: vi.fn() }));
vi.mock("@/lib/staffing/notifications", () => ({ flushStaffingNotifications: calls.retry }));
vi.mock("@/lib/stores", () => ({ listStores: calls.stores, businessDateForTimeZone: () => "2026-11-09" }));
vi.mock("@/lib/sync", () => ({ createSyncRun: calls.create, syncStoreData: calls.sync, completeSyncRun: calls.complete, cleanupSyncRuns: calls.cleanup }));
import { handler } from "@/aws/lambda/worker";
const store = { id: "test-store", name: "Store A", timeZone: "Asia/Jakarta", utcOffset: "+07:00" };
function context() { return { getRemainingTimeInMillis: vi.fn().mockReturnValueOnce(58000).mockReturnValueOnce(58000).mockReturnValue(4000) }; }
beforeEach(() => {
  vi.stubEnv("REFRESH_TIME", "3"); calls.retry.mockReset().mockResolvedValue({ sent: 0 }); calls.stores.mockReset().mockResolvedValue([store]);
  calls.create.mockReset().mockResolvedValue(1); calls.sync.mockReset().mockResolvedValue({ transactionCount: 10, itemCount: 12 }); calls.complete.mockReset().mockResolvedValue(undefined); calls.cleanup.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("existing POS schedule shares a bounded Staffing retry pass", () => {
  it("preserves successful POS results if Staffing retries fail", async () => {
    calls.retry.mockRejectedValue(new Error("staffing unavailable"));
    expect((await handler({}, context())).stores[0]).toMatchObject({ successfulCycles: 1, transactionCount: 10 });
    expect(calls.retry).toHaveBeenCalledWith({ budgetMs: 3000, maxMessages: 2 }); expect(calls.complete).toHaveBeenCalledOnce();
  });
  it("runs POS while retry work is in flight, but awaits the bounded retry before returning", async () => {
    let finish!: (value: unknown) => void; calls.retry.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const running = handler({}, context()); await vi.waitFor(() => expect(calls.complete).toHaveBeenCalledOnce());
    expect(calls.sync).toHaveBeenCalledOnce(); finish({ sent: 1 }); await running;
  });
  it("retains the original POS error and still completes independent retry work", async () => {
    calls.stores.mockRejectedValue(new Error("POS unavailable"));
    await expect(handler({}, context())).rejects.toThrow("POS unavailable"); expect(calls.retry).toHaveBeenCalledOnce();
  });
  it("does not allocate a retry budget from time reserved for POS finalization", async () => {
    calls.stores.mockResolvedValue([]);
    await expect(handler({}, { getRemainingTimeInMillis: () => 4000 })).rejects.toThrow("No active stores");
    expect(calls.retry).toHaveBeenCalledWith({ budgetMs: 0, maxMessages: 2 });
  });
});
