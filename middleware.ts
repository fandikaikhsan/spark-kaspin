import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { allowedPath, currentSession } from "@/lib/auth/current-user";

export async function middleware(request: NextRequest) {
  // Telegram authenticates with its own secret header, independently of dashboard cookies.
  if (request.nextUrl.pathname === "/api/telegram/staffing") return NextResponse.next();
  let session;
  try {
    session = await currentSession(await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value));
  } catch {
    return new Response("Account verification temporarily unavailable", { status: 503 });
  }
  if (session) {
    if (allowedPath(session.role, request.nextUrl.pathname)) return NextResponse.next();
    if (request.nextUrl.pathname.startsWith("/api/")) return Response.json({ error: "Access denied" }, { status: 403 });
    return NextResponse.redirect(new URL("/staffing", request.url));
  }
  if (request.nextUrl.pathname.startsWith("/api/")) return Response.json({ error: "Authentication required" }, { status: 401 });
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!login$|api/auth/login$|api/auth/logout$|_next/static|_next/image|favicon.ico|logo_sarkop_red.png).*)"],
};
