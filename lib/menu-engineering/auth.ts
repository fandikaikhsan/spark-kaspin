import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { EngineeringError } from "./model";

export async function requireEngineeringAdmin() {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) throw new EngineeringError("Authentication required", 401);
  if (session.role !== "admin" && session.role !== "super_admin") throw new EngineeringError("Admin access required", 403);
  return session;
}
export function engineeringErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Could not process menu engineering request" },
    { status: error instanceof EngineeringError ? error.status : 500 });
}
export async function readEngineeringBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new EngineeringError("Request must contain a valid JSON object"); }
}
