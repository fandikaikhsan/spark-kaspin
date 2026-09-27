import { STORE_TIME_ZONES, type StoreTimeZone } from "@/lib/stores";

export type StoreSettingsInput = {
  name: string;
  timeZone: StoreTimeZone;
  active: boolean;
  accessToken?: string;
  refreshToken?: string;
};

export type StoreAdminSummary = {
  id: string;
  name: string;
  timeZone: StoreTimeZone;
  utcOffset: string;
  isDefault: boolean;
  active: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  credentialsUpdatedAt: string | null;
};

export function parseStoreSettingsInput(
  value: unknown,
  options: { requireRefreshToken: boolean },
): StoreSettingsInput {
  if (!value || typeof value !== "object") throw new Error("Store settings must be an object");
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const timeZone = typeof input.timeZone === "string" ? input.timeZone : "";
  const accessToken = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
  const refreshToken = typeof input.refreshToken === "string" ? input.refreshToken.trim() : "";

  if (!name) throw new Error("Store name is required");
  if (!(timeZone in STORE_TIME_ZONES)) throw new Error("Select a supported store timezone");
  if (options.requireRefreshToken && !refreshToken) {
    throw new Error("An initial refresh token is required for a new store");
  }

  return {
    name,
    timeZone: timeZone as StoreTimeZone,
    active: input.active !== false,
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}
