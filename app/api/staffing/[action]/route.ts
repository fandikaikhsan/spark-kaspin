import { manageStaffing, staffingResponse } from "@/lib/staffing/service";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const origin = request.headers.get("origin");
  if ((origin && new URL(origin).host !== new URL(request.url).host) || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Invalid request origin or content type" }, { status: 403 });
  try {
    const { action } = await context.params;
    return Response.json(await manageStaffing(action, await request.json()), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return staffingResponse(error); }
}
