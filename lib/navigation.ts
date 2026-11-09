import type { AuthSession } from "@/lib/auth/session";

export type NavigationAccount = Pick<AuthSession, "username" | "role">;
export type NavigationNotifications = {
  total: number;
  items: { id: string; title: string; description: string; count: number; href: string }[];
};

// A cancelable event lets pages with unsaved work guard global navigation too.
export function navigationAllowed() {
  return window.dispatchEvent(new Event("spark:navigate", { cancelable: true }));
}
