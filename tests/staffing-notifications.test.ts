import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedFetch, flushStaffingNotifications } from "@/lib/staffing/notifications";
const row = { id: 1, method: "sendMessage", payload: { chat_id: -1001, text: "Attendance confirmation" }, failures: 0 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.stubEnv("STAFFING_TELEGRAM_BOT_TOKEN", "200:staff-test-token"); vi.stubEnv("TELEGRAM_BOT_TOKEN", "100:pos-test-token");
  vi.stubEnv("SUPABASE_URL", "https://supabase.invalid"); vi.stubEnv("SUPABASE_SECRET_KEY", "local-test-key");
  fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("bounded Staffing notifications", () => {
  it("is a no-op when disabled or the remaining budget is too small", async () => {
    expect((await flushStaffingNotifications({ budgetMs: 0 })).skipped).toBe(true);
    vi.stubEnv("STAFFING_TELEGRAM_BOT_TOKEN", ""); expect((await flushStaffingNotifications()).skipped).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("claims, sends through the Staffing bot, records a receipt and stops on an empty queue", async () => {
    fetcher.mockResolvedValueOnce(json([row])).mockResolvedValueOnce(json({ ok: true, result: { message_id: 77 } })).mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json([]));
    expect(await flushStaffingNotifications()).toEqual({ sent: 1, skipped: false, deferred: false });
    expect(String(fetcher.mock.calls[1][0])).toContain("bot200:staff-test-token/sendMessage");
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual(row.payload);
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toEqual({ p_id: 1, p_message_id: 77 });
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });
  it("respects the message count cap without taking another lease", async () => {
    fetcher.mockResolvedValueOnce(json([row])).mockResolvedValueOnce(json({ ok: true, result: { message_id: 77 } })).mockResolvedValueOnce(json(null));
    expect((await flushStaffingNotifications({ maxMessages: 1 })).sent).toBe(1); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("backs off failed sends without recording a receipt", async () => {
    fetcher.mockResolvedValueOnce(json([row])).mockResolvedValueOnce(json({ ok: false }, 429)).mockResolvedValueOnce(json(null));
    expect((await flushStaffingNotifications()).deferred).toBe(true);
    expect(fetcher.mock.calls[2][1]?.method).toBe("PATCH"); expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string).failures).toBe(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("staffing_deliver_outbox"))).toBe(false);
  });
  it("cancels network work at its deadline and leaves the claimed lease for a later retry", async () => {
    fetcher.mockResolvedValueOnce(json([row])).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const started = Date.now(); const result = await flushStaffingNotifications({ budgetMs: 600 });
    expect(result).toEqual({ sent: 0, skipped: false, deferred: true }); expect(Date.now() - started).toBeLessThan(2000); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("fails safely on an unavailable queue or duplicate POS bot identity", async () => {
    fetcher.mockResolvedValueOnce(json({ message: "queue unavailable" }, 503));
    await expect(flushStaffingNotifications()).rejects.toThrow("Staffing notification processing failed");
    fetcher.mockClear(); vi.stubEnv("STAFFING_TELEGRAM_BOT_TOKEN", "100:rotated-token");
    await expect(flushStaffingNotifications()).rejects.toThrow("distinct bot identities"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves an earlier caller abort signal as well as its total deadline", async () => {
    const deadline = new AbortController(), caller = new AbortController();
    fetcher.mockResolvedValue(json({})); await boundedFetch(deadline.signal)("https://local.invalid", { signal: caller.signal });
    const signal = fetcher.mock.calls[0][1]?.signal; expect(signal?.aborted).toBe(false); caller.abort(); expect(signal?.aborted).toBe(true);
  });
});
