function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function posEnv() {
  return {
    baseUrl: required("BASE_URL").replace(/\/$/, ""),
    accessToken: process.env.TOKEN?.trim() || null,
    refreshToken: required("REFRESH_TOKEN"),
    utcOffset: process.env.POS_UTC_OFFSET?.trim() || "+07:00",
  };
}

export function refreshIntervalSeconds(): number {
  const parsed = Number(process.env.REFRESH_TIME || "3");
  return Number.isFinite(parsed) && parsed >= 3 ? Math.floor(parsed) : 3;
}

export function hasSupabaseConfig(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
      (process.env.SUPABASE_SECRET_KEY?.trim() ||
        process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
  );
}

export function supabaseEnv() {
  return {
    url: required("SUPABASE_URL"),
    secretKey:
      process.env.SUPABASE_SECRET_KEY?.trim() || required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
