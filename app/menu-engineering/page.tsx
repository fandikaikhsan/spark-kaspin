import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
// Preserve bookmarked URLs while retiring the old, separate recipe editor.
export default function MenuEngineeringPage() { redirect("/products"); }
