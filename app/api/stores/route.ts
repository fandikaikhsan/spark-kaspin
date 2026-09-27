import { createStore, listStoreAdminSummaries } from "@/lib/store-admin";
import { parseStoreSettingsInput } from "@/lib/store-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ stores: await listStoreAdminSummaries() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load stores" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const input = parseStoreSettingsInput(await request.json(), { requireRefreshToken: true });
    await createStore(input);
    return Response.json({ stores: await listStoreAdminSummaries() }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create store" },
      { status: 400 },
    );
  }
}
