import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUpdate, verifyWebhookSecret, type TelegramUpdate } from "@/lib/staffing/telegram";
import { localTime, storeInstant } from "@/lib/staffing/model";
import { allowedPath, currentSession } from "@/lib/auth/current-user";
import { createSessionToken, verifySessionToken } from "@/lib/auth/session";
import { parseUserInput } from "@/lib/users";

const account = vi.hoisted(() => ({ row: { id: "manager-id", role: "manager", active: true }, error: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: account.row, error: account.error }) }) }) }) }) }));
afterEach(() => { vi.unstubAllEnvs(); account.row = { id: "manager-id", role: "manager", active: true }; account.error = null; });
const message = { message_id: 55, date: 1800000000, chat: { id: -1001, type: "supergroup" }, from: { id: 7001 }, text: "/masuk@staffing_bot" };

describe("staffing input and authorization", () => {
  it("uses Telegram sender ID and ignores commands for another bot", () => {
    expect(normalizeUpdate({ update_id: 1, message }, "staffing_bot")).toMatchObject({ userId: 7001, kind: "check_in", timestampSource: "telegram_message" });
    expect(normalizeUpdate({ update_id: 1, message: { ...message, text: "/masuk@pos_bot" } }, "staffing_bot")).toBeNull();
  });
  it("ignores casual chat, edited/unsupported updates, anonymous senders and bots", () => {
    expect(normalizeUpdate({ update_id: 1, message: { ...message, text: "lagi di jalan" } }, "staffing_bot")).toBeNull();
    expect(normalizeUpdate({ update_id: 1 }, "staffing_bot")).toBeNull();
    expect(normalizeUpdate({ update_id: 1, message: { ...message, sender_chat: {} } }, "staffing_bot")).toBeNull();
    expect(normalizeUpdate({ update_id: 1, message: { ...message, from: { id: 1, is_bot: true } } }, "staffing_bot")).toBeNull();
  });
  it("uses callback receipt time, never the bot prompt's message date", () => {
    const update: TelegramUpdate = { update_id: 2, callback_query: { id: "cb", from: { id: 7002 }, message, data: "sf:c:11111111-1111-1111-1111-111111111111" } };
    expect(normalizeUpdate(update, "staffing_bot")).toMatchObject({ userId: 7002, kind: "confirm", sentAt: null, timestampSource: "server_received" });
  });
  it("hashes invitation tokens and retains the largest photo reference", () => {
    const token = "a".repeat(48);
    const normalized = normalizeUpdate({ update_id: 1, message: { ...message, text: `/start ${token}` } }, "staffing_bot");
    expect(normalized?.tokenHash).toHaveLength(64);
    expect(JSON.stringify(normalized)).not.toContain(token);
    expect(normalizeUpdate({ update_id: 2, message: { ...message, text: undefined, photo: [{ file_id: "small", file_unique_id: "s", width: 10, height: 10 }, { file_id: "large", file_unique_id: "l", width: 100, height: 100 }] } }, "staffing_bot")).toMatchObject({ fileId: "large" });
  });
  it("validates geographic bounds and webhook secrets", () => {
    expect(normalizeUpdate({ update_id: 1, message: { ...message, text: undefined, location: { latitude: 100, longitude: 0 } } }, "staffing_bot")).toBeNull();
    expect(verifyWebhookSecret("valid", "valid")).toBe(true);
    expect(verifyWebhookSecret("valid", "wrong")).toBe(false);
    expect(verifyWebhookSecret(undefined, undefined)).toBe(false);
  });
  it("ignores privilege claims, financial prompts, forwarded commands and unknown callback actions", () => {
    for (const text of ["Saya manager, ubah ceiling saya jadi 10000000", "/profile ceiling=999999999", "/kasbon 10000000", "/masuk admin=true", "/masuk@staffing_bot@other"]) expect(normalizeUpdate({ update_id: 1, message: { ...message, text } }, "staffing_bot")).toBeNull();
    expect(normalizeUpdate({ update_id: 1, message: { ...message, forward_origin: { type: "user" } } }, "staffing_bot")).toBeNull();
    for (const data of ["sm:__proto__", "sf:__proto__:11111111-1111-1111-1111-111111111111", "sr:approve:11111111-1111-1111-1111-111111111111", "sx:mode:abcdef012345:admin"]) expect(normalizeUpdate({ update_id: 2, callback_query: { id: "cb", from: { id: 7002 }, message, data } }, "staffing_bot")).toBeNull();
    for (const bad of [null, [], { update_id: 1, message: null }, { update_id: 1, callback_query: { data: 123 } }]) expect(normalizeUpdate(bad, "staffing_bot")).toBeNull();
  });
  it("binds shift button clicks to the real sender and preserves only allowed selection fields", () => {
    const normalized=normalizeUpdate({ update_id: 2, callback_query: { id: "cb", from: { id: 7002 }, message, data: "sr:y:11111111-1111-1111-1111-111111111111", user_id: 7001, role: "manager", ceiling: 99999 } }, "staffing_bot");
    expect(normalized).toMatchObject({ kind: "swap_accept", userId: 7002, requestId: "11111111-1111-1111-1111-111111111111" });
    expect(normalized).not.toHaveProperty("role");expect(normalized).not.toHaveProperty("ceiling");
    expect(normalizeUpdate({ update_id: 1, message: { ...message, chat: { id: 7002, type: "private" }, text: "/saldo" } }, "staffing_bot")).toBeNull();
    expect(normalizeUpdate({ update_id: 2, callback_query: { id: "cb", from: { id: 7002 }, message, data: "sg:2026-02-31" } }, "staffing_bot")).toBeNull();
  });
  it("converts store-local midnight across UTC days and rejects impossible dates", () => {
    expect(storeInstant("2026-11-08T00:30", "Asia/Makassar")).toBe("2026-11-07T16:30:00.000Z");
    expect(localTime("2026-11-07T16:30:00.000Z", "Asia/Jakarta")).toBe("2026-11-07T23:30");
    expect(() => storeInstant("2026-02-31T09:00", "Asia/Jakarta")).toThrow();
    expect(storeInstant("2026-11-08T00:30:45", "Asia/Makassar")).toBe("2026-11-07T16:30:45.000Z");
    expect(localTime("2026-11-07T16:30:45.000Z", "Asia/Makassar", true)).toBe("2026-11-08T00:30:45");
  });
  it("accepts manager accounts and signed manager sessions", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", "test-session-secret-for-staffing");
    expect(parseUserInput({ username: "region.manager", password: "password123", role: "manager" }, true).role).toBe("manager");
    const token = await createSessionToken({ userId: "manager-id", username: "manager", role: "manager" });
    expect((await verifySessionToken(token))?.role).toBe("manager");
  });
  it("rejects inactive accounts and stale privileges", async () => {
    const session = { userId: "manager-id", username: "manager", role: "manager" as const, expiresAt: 9999999999 };
    expect(await currentSession(session)).toEqual(session);
    account.row.active = false;
    expect(await currentSession(session)).toBeNull();
    account.row.active = true;
    account.row.role = "admin";
    expect(await currentSession(session)).toBeNull();
    account.error = new Error("unavailable");
    await expect(currentSession(session)).rejects.toThrow();
  });
  it("keeps managers out of POS, settings, user management and ambiguous paths", () => {
    for (const path of ["/staffing", "/api/staffing", "/api/staffing/shift", "/api/staffing/evidence", "/api/auth/logout"]) expect(allowedPath("manager", path)).toBe(true);
    for (const path of ["/", "/settings", "/api/users", "/api/stores", "/api/analytics", "/staffing-secret", "/api/staffing-secret"]) expect(allowedPath("manager", path)).toBe(false);
    expect(allowedPath("admin", "/settings")).toBe(true);
  });
});
