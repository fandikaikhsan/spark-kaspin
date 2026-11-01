import { parseReceiving } from "@/lib/receiving/model";
import { saveReceiving } from "@/lib/receiving/service";
import { employeeSubmissionError, readEmployeeSubmission } from "@/lib/operations/employee-requests";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const input = parseReceiving(await readEmployeeSubmission(request));
    const result = await saveReceiving(input, "employee-form");
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return employeeSubmissionError(error); }
}
