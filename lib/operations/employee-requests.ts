import { ItemError } from "@/lib/items/model";

export async function readEmployeeSubmission(request: Request): Promise<unknown> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new ItemError("Kirim formulir dari halaman toko ini.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ItemError("Format formulir tidak valid.", 415);
  if (Number(request.headers.get("content-length")) > 128000) throw new ItemError("Formulir terlalu besar.", 413);
  const text = await request.text();
  if (text.length > 128000) throw new ItemError("Formulir terlalu besar.", 413);
  try { return JSON.parse(text); } catch { throw new ItemError("Formulir tidak valid. Coba kirim kembali."); }
}
export function employeeSubmissionError(error: unknown): Response {
  const status = error instanceof ItemError ? error.status : 500;
  const message = status >= 500 ? "Formulir belum tersedia. Hubungi pengelola toko atau coba lagi sebentar." : status === 409
    ? "Data berubah atau pengiriman ini sudah tersimpan dengan isian berbeda. Hubungi pengelola toko sebelum mengirim ulang."
    : error instanceof Error ? error.message : "Formulir gagal disimpan.";
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
