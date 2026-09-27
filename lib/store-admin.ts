import { STORE_TIME_ZONES, listStores } from "@/lib/stores";
import type { StoreAdminSummary, StoreSettingsInput } from "@/lib/store-settings";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type CredentialState = {
  store_id: string;
  access_token: string | null;
  refresh_token: string;
  updated_at: string;
};

function jwtExpiry(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return typeof decoded.exp === "number" ? new Date(decoded.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export async function listStoreAdminSummaries(): Promise<StoreAdminSummary[]> {
  const [stores, credentialsResult] = await Promise.all([
    listStores(false),
    getSupabaseAdmin()
      .from("integration_credentials")
      .select("store_id,access_token,refresh_token,updated_at")
      .eq("provider", "pos"),
  ]);
  if (credentialsResult.error) {
    throw new Error(`Could not load store credentials: ${credentialsResult.error.message}`);
  }

  const credentials = new Map(
    ((credentialsResult.data || []) as CredentialState[]).map((credential) => [
      credential.store_id,
      credential,
    ]),
  );
  return stores.map((store) => {
    const credential = credentials.get(store.id);
    return {
      ...store,
      hasAccessToken: Boolean(credential?.access_token),
      hasRefreshToken: Boolean(credential?.refresh_token),
      credentialsUpdatedAt: credential?.updated_at || null,
    };
  });
}

export async function createStore(input: StoreSettingsInput): Promise<void> {
  if (!input.refreshToken) throw new Error("A refresh token is required for a new store");
  const existingStores = await listStores(false);
  const supabase = getSupabaseAdmin();
  const { data: store, error: storeError } = await supabase
    .from("stores")
    .insert({
      name: input.name,
      time_zone: input.timeZone,
      utc_offset: STORE_TIME_ZONES[input.timeZone],
      active: input.active,
      is_default: existingStores.length === 0,
    })
    .select("id")
    .single();
  if (storeError) throw new Error(`Could not create store: ${storeError.message}`);

  const { error: credentialError } = await supabase.from("integration_credentials").insert({
    store_id: store.id,
    provider: "pos",
    access_token: input.accessToken || null,
    refresh_token: input.refreshToken,
    access_token_expires_at: jwtExpiry(input.accessToken),
  });
  if (credentialError) {
    await supabase.from("stores").delete().eq("id", store.id);
    throw new Error(`Could not save store credentials: ${credentialError.message}`);
  }
}

export async function updateStore(storeId: string, input: StoreSettingsInput): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error: storeError } = await supabase
    .from("stores")
    .update({
      name: input.name,
      time_zone: input.timeZone,
      utc_offset: STORE_TIME_ZONES[input.timeZone],
      active: input.active,
      updated_at: new Date().toISOString(),
    })
    .eq("id", storeId);
  if (storeError) throw new Error(`Could not update store: ${storeError.message}`);

  if (!input.accessToken && !input.refreshToken) return;
  const { data: existing, error: existingError } = await supabase
    .from("integration_credentials")
    .select("access_token,refresh_token")
    .eq("store_id", storeId)
    .eq("provider", "pos")
    .maybeSingle();
  if (existingError) throw new Error(`Could not load current credentials: ${existingError.message}`);

  const refreshToken = input.refreshToken || existing?.refresh_token;
  if (!refreshToken) throw new Error("A refresh token is required before credentials can be saved");
  const accessToken = input.accessToken || existing?.access_token || null;
  const { error: credentialError } = await supabase.from("integration_credentials").upsert(
    {
      store_id: storeId,
      provider: "pos",
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_expires_at: jwtExpiry(accessToken || undefined),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,provider" },
  );
  if (credentialError) throw new Error(`Could not update store credentials: ${credentialError.message}`);
}
