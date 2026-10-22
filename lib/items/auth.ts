import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { ItemError } from "./model";

// Existing app roles: admin = manager; super_admin = owner/bootstrap administrator.
// Do not grant this feature to a new role by default (e.g. employee).
export function canManageItems(role: unknown): boolean {
  return role === "admin" || role === "super_admin";
}

export async function requireItemManager() {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) throw new ItemError("Authentication required", 401);
  if (!canManageItems(session.role)) throw new ItemError("Only managers and owners can access Items", 403);
  return session;
}

export function itemErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Could not process item request" }, {
    status: error instanceof ItemError ? error.status : 500,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readItemBody(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new ItemError("Request must contain valid JSON"); }
}
