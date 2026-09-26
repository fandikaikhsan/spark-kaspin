import { posEnv } from "@/lib/env";
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

async function readCredential(): Promise<StoredCredential | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("integration_credentials")
    .select("access_token,refresh_token,access_token_expires_at")
    .eq("provider", "pos")
    .maybeSingle();

  if (error) throw new Error(`Could not read POS credentials: ${error.message}`);
  return data;
}

async function saveCredential(accessToken: string, refreshToken: string) {
  const { error } = await getSupabaseAdmin().from("integration_credentials").upsert(
    {
      provider: "pos",
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: jwtExpiry(accessToken)?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider" },
  );

  if (error) throw new Error(`Could not save refreshed POS credentials: ${error.message}`);
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { baseUrl } = posEnv();
  const response = await fetch(`${baseUrl}/api/refresh-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`POS token refresh failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as PosRefreshResponse;
  if (payload.status !== "success" || !payload.data?.token || !payload.data?.token_refresh) {
    throw new Error("POS token refresh returned an unexpected response");
  }

  await saveCredential(payload.data.token, payload.data.token_refresh);
  return payload.data.token;
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  const env = posEnv();
  const stored = await readCredential();

  if (!forceRefresh && stored && isUsable(stored.access_token, stored.access_token_expires_at)) {
    return stored.access_token;
  }

  if (!forceRefresh && isUsable(env.accessToken, null)) {
    return env.accessToken;
  }

  return refreshAccessToken(stored?.refresh_token || env.refreshToken);
}

async function authenticatedFetch(path: string): Promise<Response> {
  const { baseUrl } = posEnv();
  let token = await getAccessToken();
  let response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (response.status === 401) {
    token = await getAccessToken(true);
    response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  }

  return response;
}

export async function fetchTransactionsForDate(date: string): Promise<PosTransaction[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must use YYYY-MM-DD");
  const [year, month, day] = date.split("-");
  const response = await authenticatedFetch(
    `/api/web/laporan/penjualan/list-data-penjualan/${year}/${month}/${day}`,
  );

  if (!response.ok) throw new Error(`POS transaction request failed with HTTP ${response.status}`);
  const payload = (await response.json()) as PosListResponse;
  if (payload.status !== "success" || !Array.isArray(payload.data)) {
    throw new Error("POS transaction endpoint returned an unexpected response");
  }

  return payload.data;
}
