import { staffingDashboard, staffingResponse } from "@/lib/staffing/service";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await staffingDashboard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return staffingResponse(error); }
}
