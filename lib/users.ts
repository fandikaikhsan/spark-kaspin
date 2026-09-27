import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type ManagedUser = {
  id: string;
  username: string;
  role: "admin";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserInput = {
  username: string;
  password?: string;
  role: "admin";
  active: boolean;
};

type UserRow = {
  id: string;
  username: string;
  normalized_username: string;
  password_hash: string;
  role: "admin";
  active: boolean;
  created_at: string;
  updated_at: string;
};

type UserSummaryRow = Omit<UserRow, "normalized_username" | "password_hash">;

function summarize(row: UserSummaryRow): ManagedUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseUserInput(value: unknown, requirePassword: boolean): UserInput {
  if (!value || typeof value !== "object") throw new Error("User details must be an object");
  const input = value as Record<string, unknown>;
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const role = input.role || "admin";

  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    throw new Error("Username must be 3–40 characters using letters, numbers, dots, dashes, or underscores");
  }
  if ((requirePassword || password) && password.length < 8) {
    throw new Error("Password must contain at least 8 characters");
  }
  if (role !== "admin") throw new Error("Admin is the only available role");

  return {
    username,
    role: "admin",
    active: input.active !== false,
    ...(password ? { password } : {}),
  };
}

export async function listUsers(): Promise<ManagedUser[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_users")
    .select("id,username,role,active,created_at,updated_at")
    .order("username", { ascending: true });
  if (error) throw new Error(`Could not load users: ${error.message}`);
  return ((data || []) as UserSummaryRow[]).map(summarize);
}

export async function authenticateManagedUser(username: string, password: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("app_users")
    .select("id,username,normalized_username,password_hash,role,active,created_at,updated_at")
    .eq("normalized_username", username.trim().toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Could not authenticate user: ${error.message}`);
  const row = data as UserRow | null;
  if (!row || !row.active || !(await verifyPassword(password, row.password_hash))) return null;
  return summarize(row);
}

export async function createUser(input: UserInput): Promise<void> {
  if (!input.password) throw new Error("Password is required");
  const { error } = await getSupabaseAdmin().from("app_users").insert({
    username: input.username,
    normalized_username: input.username.toLowerCase(),
    password_hash: await hashPassword(input.password),
    role: input.role,
    active: input.active,
  });
  if (error) {
    if (error.code === "23505") throw new Error("That username is already in use");
    throw new Error(`Could not create user: ${error.message}`);
  }
}

export async function updateUser(userId: string, input: UserInput): Promise<void> {
  const updates: Record<string, string | boolean> = {
    username: input.username,
    normalized_username: input.username.toLowerCase(),
    role: input.role,
    active: input.active,
    updated_at: new Date().toISOString(),
  };
  if (input.password) updates.password_hash = await hashPassword(input.password);

  const { error } = await getSupabaseAdmin().from("app_users").update(updates).eq("id", userId);
  if (error) {
    if (error.code === "23505") throw new Error("That username is already in use");
    throw new Error(`Could not update user: ${error.message}`);
  }
}
