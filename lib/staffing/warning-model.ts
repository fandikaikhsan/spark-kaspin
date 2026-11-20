import type { StaffDetail } from "./operations-model";
import { addDays } from "./schedule";
export const severityOptions = [
  { value: "light", label: "Ringan", points: 1 }, { value: "moderate", label: "Sedang", points: 2 },
  { value: "severe", label: "Berat", points: 3 }, { value: "critical", label: "Sangat berat", points: 4 },
] as const;
export type Severity = typeof severityOptions[number]["value"];
export type WarningData = {
  level: number; severity: Severity; subject: string; job_title: string; letter_date: string; incident_date: string; incident_time: string;
  incident_place: string; chronology: string; findings: string; policy_reference: string; clarification: string;
  corrective_actions: string; consequences: string; sanction_note: string; monitoring_start: string; monitoring_end: string;
  issue_city: string; signer_name: string; signer_role: string;
};
export type PointSummary = { balance: number; version: string };
export type WarningEvent = { id: number; warning_id?: string | null; event: string; actor_label: string; details: Record<string, unknown>; created_at: string };
export type WarningRow = { id: string; number: string | null; status: "draft" | "issued" | "revoked"; revision: number; level: number; severity: Severity; points: number | null; subject: string; letter_date: string; monitoring_end: string; created_at: string; issued_at: string | null };
export type PointEntry = { id: string; points: number; reason: string; entry_kind: "legacy" | "warning" | "reduction" | "reversal" | "adjustment"; warning_id: string | null; actor: string; context: { before?: number; after?: number }; created_at: string };
export type WarningOverview = { points: PointSummary; warnings: WarningRow[]; ledger: PointEntry[]; events: WarningEvent[] };
export type WarningDocumentData = {
  id: string; staff_id: string; staff_name: string; staff_code: string; store_name: string; time_zone: string;
  data: WarningData; status: WarningRow["status"]; revision: number; number: string | null; issued_points: number | null; points_before: number | null; points_after: number | null;
  issued_at: string | null; revoked_at: string | null; revocation_reason: string | null; document_version: string;
  recipient_linked: boolean; recipient_version: string; delivery_state: "sending" | "sent" | "failed" | "uncertain" | null; delivery_updated_at: string | null;
};
export type WarningDetail = WarningDocumentData & { events: WarningEvent[] };
export const warningStateLabels = { draft: "Draft", issued: "Terbit", revoked: "Dibatalkan" };
export const eventLabels: Record<string, string> = { draft_created: "Draft dibuat", draft_updated: "Draft diperbarui", issued: "Surat diterbitkan", points_reduced: "Poin dikurangi", points_adjusted: "Poin diubah", revoked: "Surat dibatalkan", download_requested: "Download diminta", send_started: "Pengiriman dimulai", send_sent: "PDF terkirim", send_failed: "Pengiriman gagal", send_uncertain: "Status kirim belum pasti", delivery_verified: "Pengiriman diverifikasi manual" };
export const pointKindLabels: Record<string, string> = { legacy: "Catatan SP lama", warning: "Penerbitan SP", reduction: "Pengurangan oleh manager", reversal: "Pembatalan SP", adjustment: "Perubahan poin" };
export function monitoringEnd(start: string): string {
  const date = new Date(start + "T00:00:00Z");
  if (!Number.isFinite(date.getTime())) return "";
  const day = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 6);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); date.setUTCDate(Math.min(day, last));
  return addDays(date.toISOString().slice(0, 10), -1);
}
export function defaultWarning(detail: StaffDetail, today: string): WarningData {
  return { level: 1, severity: "light", subject: "Peringatan dan pembinaan kedisiplinan kerja", job_title: "Pegawai Negeri Sarkop", letter_date: today, incident_date: today, incident_time: "", incident_place: detail.store.name,
    chronology: "", findings: "", policy_reference: "", clarification: "", corrective_actions: "", consequences: "Apabila pelanggaran serupa terulang, manajemen akan melakukan evaluasi dan menentukan tindak lanjut sesuai kebijakan yang berlaku.", sanction_note: "", monitoring_start: today, monitoring_end: monitoringEnd(today), issue_city: "", signer_name: "", signer_role: `Manager ${detail.store.name}` };
}
