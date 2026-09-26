import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasSupabaseConfig, supabaseEnv } from "@/lib/env";

let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!hasSupabaseConfig()) {
    throw new Error("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SECRET_KEY.");
  }

  if (!client) {
    const { url, secretKey } = supabaseEnv();
    client = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return client;
}
