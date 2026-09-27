export const SESSION_COOKIE = "spark_intelligence_session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export type UserRole = "super_admin" | "admin";

export type AuthSession = {
  userId: string;
  username: string;
  role: UserRole;
  expiresAt: number;
};

function sessionSecret(): string {
  const value =
    process.env.AUTH_SESSION_SECRET?.trim() ||
    process.env.SETTINGS_ADMIN_PASSWORD?.trim();
  if (!value) throw new Error("Missing AUTH_SESSION_SECRET");
  return value;
}

function toBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function signature(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(signed));
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function createSessionToken(
  user: Pick<AuthSession, "userId" | "username" | "role">,
): Promise<string> {
  const payload = toBase64Url(JSON.stringify({
    ...user,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  } satisfies AuthSession));
  return `${payload}.${await signature(payload)}`;
}

export async function verifySessionToken(token: string | undefined): Promise<AuthSession | null> {
  if (!token) return null;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;

  try {
    if (!safeEqual(suppliedSignature, await signature(payload))) return null;
    const session = JSON.parse(fromBase64Url(payload)) as Partial<AuthSession>;
    if (
      typeof session.userId !== "string" ||
      typeof session.username !== "string" ||
      (session.role !== "admin" && session.role !== "super_admin") ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Math.floor(Date.now() / 1000)
    ) return null;
    return session as AuthSession;
  } catch {
    return null;
  }
}
