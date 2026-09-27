import { afterEach, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { parseUserInput } from "@/lib/users";

const originalSecret = process.env.AUTH_SESSION_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AUTH_SESSION_SECRET;
  else process.env.AUTH_SESSION_SECRET = originalSecret;
});

describe("dashboard authentication", () => {
  it("hashes passwords without storing the plaintext", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("incorrect", hash)).resolves.toBe(false);
  });

  it("signs and validates an admin session", async () => {
    process.env.AUTH_SESSION_SECRET = "test-secret-with-enough-entropy-for-this-test";
    const token = await createSessionToken({ userId: "user-1", username: "admin", role: "admin" });
    await expect(verifySessionToken(token)).resolves.toMatchObject({
      userId: "user-1",
      username: "admin",
      role: "admin",
    });
    await expect(verifySessionToken(`${token}tampered`)).resolves.toBeNull();
  });

  it("only accepts the currently supported admin role", () => {
    expect(parseUserInput({ username: "branch.admin", password: "password123", role: "admin" }, true))
      .toMatchObject({ username: "branch.admin", role: "admin", active: true });
    expect(() => parseUserInput({ username: "viewer", password: "password123", role: "viewer" }, true))
      .toThrow("only available role");
  });
});
