import { NextRequest } from "next/server";
import { demoTransactionPage } from "@/lib/analytics/demo";
import { hasSupabaseConfig } from "@/lib/env";
import { businessDateForTimeZone, listStores } from "@/lib/stores";
import { getTransactionsPage } from "@/lib/transactions";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parameters = request.nextUrl.searchParams;
  if (!hasSupabaseConfig()) {
    const date = parameters.get("date") || businessDateForTimeZone("Asia/Jakarta");
    return Response.json(demoTransactionPage(date), { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const stores = await listStores(true);
    const requestedStoreId = parameters.get("store");
    const store = requestedStoreId
      ? stores.find((candidate) => candidate.id === requestedStoreId)
      : stores[0];
    if (!store) return Response.json({ error: "No matching active store was found" }, { status: 404 });

    const date = parameters.get("date") || businessDateForTimeZone(store.timeZone);
    const page = Number(parameters.get("page") || "1");
    const pageSize = Number(parameters.get("pageSize") || "20");
    if (!Number.isInteger(page) || page < 1) {
      return Response.json({ error: "page must be a positive integer" }, { status: 400 });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      return Response.json({ error: "pageSize must be between 1 and 50" }, { status: 400 });
    }

    const result = await getTransactionsPage(store, date, stores, page, pageSize);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load transactions" },
      { status: 500 },
    );
  }
}
