import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/session";
import { authenticateManagedUser } from "@/lib/users";

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      return Response.json({ error: "Enter your username and password" }, { status: 400 });
    }

    const bootstrapUsername = process.env.SETTINGS_ADMIN_USERNAME?.trim() || "";
    const bootstrapPassword = process.env.SETTINGS_ADMIN_PASSWORD?.trim() || "";
    const isBootstrapAdmin = Boolean(
      bootstrapUsername &&
      bootstrapPassword &&
      safeEqual(username.toLowerCase(), bootstrapUsername.toLowerCase()) &&
      safeEqual(password, bootstrapPassword),
    );

    const user = isBootstrapAdmin
      ? { id: "environment-super-admin", username: bootstrapUsername, role: "super_admin" as const }
      : await authenticateManagedUser(username, password);
    if (!user) {
      return Response.json({ error: "Incorrect username or password" }, { status: 401 });
    }

    const token = await createSessionToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });
    const response = NextResponse.json({ username: user.username, role: user.role });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not sign in" },
      { status: 500 },
    );
  }
}
