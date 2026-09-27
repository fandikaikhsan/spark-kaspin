import { StoreSettings } from "@/components/store-settings";
import { listStoreAdminSummaries } from "@/lib/store-admin";
import { listUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [stores, users] = await Promise.all([listStoreAdminSummaries(), listUsers()]);
  return <StoreSettings initialStores={stores} initialUsers={users} />;
}
