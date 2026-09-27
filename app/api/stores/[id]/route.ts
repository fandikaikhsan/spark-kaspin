import { listStoreAdminSummaries, updateStore } from "@/lib/store-admin";
import { parseStoreSettingsInput } from "@/lib/store-settings";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const input = parseStoreSettingsInput(await request.json(), { requireRefreshToken: false });
    await updateStore(id, input);
    return Response.json({ stores: await listStoreAdminSummaries() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not update store" },
      { status: 400 },
    );
  }
}
