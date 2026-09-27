import { StoreSettings } from "@/components/store-settings";
import { listStoreAdminSummaries } from "@/lib/store-admin";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  return <StoreSettings initialStores={await listStoreAdminSummaries()} />;
}
