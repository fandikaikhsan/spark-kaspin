import { requireItemManager, itemErrorResponse, readItemBody } from "@/lib/items/auth";
import { parseCategoryName } from "@/lib/products/model";
import { createCategory, listCategories } from "@/lib/products/service";
export const dynamic = "force-dynamic";
export async function GET() {
  try { await requireItemManager(); return Response.json({ categories: await listCategories() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return itemErrorResponse(error); }
}
export async function POST(request: Request) {
  try { await requireItemManager(); const body = await readItemBody(request); const name = parseCategoryName(body && typeof body === "object" ? (body as Record<string, unknown>).name : undefined); return Response.json({ category: await createCategory(name) }, { status: 201, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return itemErrorResponse(error); }
}
