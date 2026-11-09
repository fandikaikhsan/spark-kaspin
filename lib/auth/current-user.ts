import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { AuthSession, UserRole } from "@/lib/auth/session";

// Read current account state: old cookies must not preserve disabled accounts or
// admin privileges after a role change. Bootstrap remains environment-owned.
export async function currentSession(session: AuthSession | null): Promise<AuthSession | null> {
  if (!session) return null;
  if (session.userId === "environment-super-admin") return session.role === "super_admin" ? session : null;
  const { data, error } = await getSupabaseAdmin().from("app_users")
    .select("id,role,active").eq("id", session.userId).maybeSingle();
  if (error) throw new Error("Account verification unavailable");
  if (!data?.active || data.role !== session.role || !["admin", "manager"].includes(data.role)) return null;
  return { ...session, role: data.role as UserRole };
}

export function allowedPath(role: UserRole, pathname: string): boolean {
  if (role !== "manager") return true;
  return pathname === "/staffing" || pathname.startsWith("/staffing/") ||
    pathname === "/api/staffing" || pathname.startsWith("/api/staffing/") ||
    pathname === "/api/auth/logout";
}
