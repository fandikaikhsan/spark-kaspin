import { NextRequest, NextResponse } from "next/server";

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function middleware(request: NextRequest) {
  const expectedUsername = process.env.SETTINGS_ADMIN_USERNAME;
  const expectedPassword = process.env.SETTINGS_ADMIN_PASSWORD;
  if (!expectedUsername || !expectedPassword) {
    return new NextResponse("Store settings are not configured", { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
      const password = separator >= 0 ? decoded.slice(separator + 1) : "";
      if (safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword)) {
        return NextResponse.next();
      }
    } catch {
      // Fall through to the authentication challenge.
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Kaspin store settings"' },
  });
}

export const config = {
  matcher: ["/settings/:path*", "/api/stores/:path*"],
};
