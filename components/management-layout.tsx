import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { hasSupabaseConfig } from "@/lib/env";
import { listStores, summarizeStore } from "@/lib/stores";
import { demoAnalytics } from "@/lib/analytics/demo";
import { AppShell } from "./app-shell";

export default async function ManagementLayout({ children }: { children: React.ReactNode }) {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  const stores = hasSupabaseConfig() ? (await listStores(true)).map(summarizeStore) : demoAnalytics(new Date().toISOString().slice(0, 10)).stores;
  return <AppShell stores={stores} user={session ? { username: session.username, role: session.role } : undefined}>{children}</AppShell>;
}
