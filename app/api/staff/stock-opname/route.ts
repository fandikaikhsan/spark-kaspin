import { parseStockEntry } from "@/lib/stock-opname/model";
import { saveAutomaticStockOpname } from "@/lib/stock-opname/service";
import { employeeSubmissionError, readEmployeeSubmission } from "@/lib/operations/employee-requests";
export const dynamic = "force-dynamic";
// Submission only. No anonymous history/catalog-management operations.
export async function POST(request: Request) {
  try {
    const input = parseStockEntry(await readEmployeeSubmission(request));
    const result = await saveAutomaticStockOpname(input, "employee-form");
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return employeeSubmissionError(error); }
}
