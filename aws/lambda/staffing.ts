// Optional Lambda adapter; production Staffing webhook is served by Next.js.
export { handleStaffingWebhook as handler } from "../../lib/staffing/webhook";
