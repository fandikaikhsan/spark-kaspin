import { posBaseUrl, posEnv } from "@/lib/env";
import type { Store } from "@/lib/stores";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { PosListResponse, PosRefreshResponse, PosTransaction } from "./types";

type StoredCredential = {
  access_token: string | null;
  refresh_token: string;
  access_token_expires_at: string | null;
};

function jwtExpiry(token: string): Date | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return typeof decoded.exp === "number" ? new Date(decoded.exp * 1000) : null;
  } catch {
    return null;
  }
}

function isUsable(token: string | null, expiresAt: string | null): token is string {
  if (!token) return false;
  const expiry = expiresAt ? new Date(expiresAt) : jwtExpiry(token);
  return Boolean(expiry && expiry.getTime() > Date.now() + 60_000);
}

async function readCredential(storeId: string): Promise<StoredCredential | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("integration_credentials")
    .select("access_token,refresh_token,access_token_expires_at")
    .eq("store_id", storeId)
    .eq("provider", "pos")
    .maybeSingle();

  if (error) throw new Error(`Could not read POS credentials: ${error.message}`);
  return data;
}

async function saveCredential(storeId: string, accessToken: string, refreshToken: string) {
  const { error } = await getSupabaseAdmin().from("integration_credentials").upsert(
    {
      store_id: storeId,
      provider: "pos",
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: jwtExpiry(accessToken)?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,provider" },
  );

  if (error) throw new Error(`Could not save refreshed POS credentials: ${error.message}`);
}

async function refreshAccessToken(
  store: Store,
  refreshToken: string,
  recoverFromRotation = true,
): Promise<string> {
  const response = await fetch(`${posBaseUrl()}/api/refresh-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    cache: "no-store",
  });

  if (!response.ok) {
    // The scheduled worker and a Telegram sync can overlap. If another invocation
    // already rotated the refresh token, retry once with the newer Supabase value.
    if (recoverFromRotation && response.status === 401) {
      const latest = await readCredential(store.id);
      if (latest?.refresh_token && latest.refresh_token !== refreshToken) {
        return refreshAccessToken(store, latest.refresh_token, false);
      }
    }
    throw new Error(`POS token refresh failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as PosRefreshResponse;
  if (payload.status !== "success" || !payload.data?.token || !payload.data?.token_refresh) {
    throw new Error("POS token refresh returned an unexpected response");
  }

  await saveCredential(store.id, payload.data.token, payload.data.token_refresh);
  return payload.data.token;
}

async function getAccessToken(store: Store, forceRefresh = false): Promise<string> {
  const stored = await readCredential(store.id);
  if (!forceRefresh && stored && isUsable(stored.access_token, stored.access_token_expires_at)) {
    return stored.access_token;
  }

  // Environment credentials remain a migration fallback for the one default
  // store. Every additional store keeps its credentials in Supabase.
  const legacy = store.isDefault ? posEnv() : null;
  if (!forceRefresh && !stored && legacy && isUsable(legacy.accessToken, null)) {
    return legacy.accessToken;
  }

  const refreshToken = stored?.refresh_token || legacy?.refreshToken;
  if (!refreshToken) {
    throw new Error(`Store "${store.name}" does not have a POS refresh token`);
  }
  return refreshAccessToken(store, refreshToken);
}

async function authenticatedFetch(store: Store, path: string): Promise<Response> {
  let token = await getAccessToken(store);
  let response = await fetch(`${posBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (response.status === 401) {
    token = await getAccessToken(store, true);
    response = await fetch(`${posBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  }

  return response;
}

export async function fetchTransactionsForDate(
  store: Store,
  date: string,
): Promise<PosTransaction[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  const [year, month, day] = date.split("-");
  const response = await authenticatedFetch(
    store,
    `/api/web/laporan/penjualan/list-data-penjualan/${year}/${month}/${day}`,
  );

  if (!response.ok) throw new Error(`POS transaction request failed with HTTP ${response.status}`);
  const payload = (await response.json()) as PosListResponse;
  if (payload.status !== "success" || !Array.isArray(payload.data)) {
    throw new Error("POS transaction endpoint returned an unexpected response");
  }

  return payload.data;
}
