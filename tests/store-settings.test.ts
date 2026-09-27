import { describe, expect, it } from "vitest";
import { parseStoreSettingsInput } from "@/lib/store-settings";
import { businessDateForTimeZone, STORE_TIME_ZONES } from "@/lib/stores";

describe("store settings", () => {
  it("maps supported branch timezones to their POS offsets", () => {
    expect(STORE_TIME_ZONES["Asia/Jakarta"]).toBe("+07:00");
    expect(STORE_TIME_ZONES["Asia/Makassar"]).toBe("+08:00");
  });

  it("requires a refresh token when a store is created", () => {
    expect(() => parseStoreSettingsInput(
      { name: "Branch", timeZone: "Asia/Jakarta", active: true },
      { requireRefreshToken: true },
    )).toThrow("initial refresh token");
  });

  it("calculates each store's business date in its own timezone", () => {
    const nearMidnight = new Date("2026-09-26T16:30:00.000Z");
    expect(businessDateForTimeZone("Asia/Jakarta", nearMidnight)).toBe("2026-09-26");
    expect(businessDateForTimeZone("Asia/Makassar", nearMidnight)).toBe("2026-09-27");
  });
});
