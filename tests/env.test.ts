import { afterEach, describe, expect, it } from "vitest";
import { refreshIntervalSeconds } from "@/lib/env";

const originalRefreshTime = process.env.REFRESH_TIME;

afterEach(() => {
  if (originalRefreshTime === undefined) delete process.env.REFRESH_TIME;
  else process.env.REFRESH_TIME = originalRefreshTime;
});

describe("refreshIntervalSeconds", () => {
  it("accepts the configured three-second interval", () => {
    process.env.REFRESH_TIME = "3";
    expect(refreshIntervalSeconds()).toBe(3);
  });

  it("enforces a three-second minimum", () => {
    process.env.REFRESH_TIME = "1";
    expect(refreshIntervalSeconds()).toBe(3);
  });

  it("falls back safely when the value is invalid", () => {
    process.env.REFRESH_TIME = "not-a-number";
    expect(refreshIntervalSeconds()).toBe(3);
  });
});
