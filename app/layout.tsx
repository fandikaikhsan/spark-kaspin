import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppNavbar } from "@/components/app-navbar";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spark Intelligence",
  description: "Daily item sales and transaction activity from the POS system.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <html lang="en">
      <body>{session && <AppNavbar account={{ username: session.username, role: session.role }} />}{children}</body>
    </html>
  );
}
