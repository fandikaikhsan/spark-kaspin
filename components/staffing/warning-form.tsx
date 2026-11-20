"use client";
import { useRef, useState, type FormEvent } from "react";
import { defaultWarning, severityOptions, type WarningData, type WarningDetail } from "@/lib/staffing/warning-model";
import type { StaffDetail } from "@/lib/staffing/operations-model";
export function WarningForm({ staff, today, warning, onSaved, onCancel }: { staff: StaffDetail; today: string; warning?: WarningDetail; onSaved(id: string): void; onCancel(): void }) {
  const [data, setData] = useState<WarningData>(warning?.data || defaultWarning(staff, today));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const key = useRef<{payload:string;id:string} | null>(null);
  const field = (name: keyof WarningData, value: string | number) => setData(old => ({ ...old, [name]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); const payload=JSON.stringify({data,revision:warning?.revision});if(key.current?.payload!==payload)key.current={payload,id:crypto.randomUUID()};
    try {
      const response = await fetch("/api/staffing/warnings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_draft", data: { staff_id: staff.profile.id, ...(warning ? { warning_id: warning.id, revision: warning.revision } : {}), data, client_id: key.current.id } }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Draft belum tersimpan."); key.current = null; onSaved(result.id);
    } catch (err) { setError(err instanceof Error ? err.message : "Draft belum tersimpan."); } finally { setBusy(false); }
  }
  const input = (name: keyof WarningData, label: string, type = "text", placeholder = "") => <label>{label}<input type={type} value={String(data[name] ?? "")} maxLength={200} max={type === "date" && ["letter_date", "incident_date"].includes(name) ? today : undefined} onChange={event => field(name, event.target.value)} placeholder={placeholder} /></label>;
  const area = (name: keyof WarningData, label: string, placeholder: string, rows = 3) => <label>{label}<textarea value={String(data[name] || "")} maxLength={4000} rows={rows} onChange={event => field(name, event.target.value)} placeholder={placeholder} /></label>;
  return <form className="ops-form ops-warning-form" onSubmit={submit}><fieldset disabled={busy}>
    <p className="ops-muted">Untuk {staff.profile.full_name} · {staff.profile.code}. Simpan draft untuk memeriksa PDF sebelum menerbitkan. Poin belum bertambah pada tahap draft.</p>
    <div className="ops-field-pair"><label>Tingkat surat<select value={data.level} onChange={event => field("level", Number(event.target.value))}>{[1,2,3].map(level => <option key={level} value={level}>SP{level}</option>)}</select></label><label>Bobot pelanggaran<select value={data.severity} onChange={event => field("severity", event.target.value)}>{severityOptions.map(option => <option key={option.value} value={option.value}>{option.label} · {option.points} poin</option>)}</select><small>Tingkat SP dipilih terpisah dari jumlah poin.</small></label></div>
    {input("subject", "Perihal", "text", "Contoh: pembinaan kedisiplinan pelayanan")}
    <div className="ops-field-pair">{input("letter_date", "Tanggal surat", "date")}{input("job_title", "Jabatan / unit kerja")}</div>
    <h3>Kejadian dan hasil pemeriksaan</h3>
    <div className="ops-field-pair">{input("incident_date", "Tanggal kejadian", "date")}{input("incident_time", "Jam kejadian (opsional)", "time")}</div>
    {input("incident_place", "Tempat kejadian", "text", "Store / lokasi kejadian")}
    {area("chronology", "Kronologi kejadian", "Jelaskan fakta: apa yang terjadi, kapan, siapa yang terlibat, dan konteksnya. Minimal 20 karakter.", 4)}
    {area("findings", "Hasil pemeriksaan", "Temuan yang telah dikonfirmasi, termasuk rujukan bukti / saksi bila relevan. Minimal 10 karakter.")}
    {area("policy_reference", "Dasar peringatan / aturan yang dilanggar", "Nama SOP atau kebijakan dan ketentuan yang relevan. Jangan mengisi pasal yang belum dikonfirmasi.")}
    {area("clarification", "Klarifikasi staf (opsional)", "Ringkasan tanggapan staf atau catatan bahwa klarifikasi belum tersedia.")}
    <h3>Perbaikan dan masa pembinaan</h3>
    {area("corrective_actions", "Tindakan perbaikan yang diminta", "Satu langkah per baris: tindakan, target perbaikan, dan cara evaluasi. Minimal 10 karakter.", 4)}
    {area("consequences", "Tindak lanjut bila terulang", "Tindak lanjut sesuai kebijakan perusahaan yang telah dikonfirmasi.")}
    {area("sanction_note", "Sanksi tambahan (opsional)", "Isi hanya sanksi yang sudah ditetapkan manager. Isian ini dicetak pada surat; tidak membukukan potongan payroll.", 2)}
    <div className="ops-field-pair">{input("monitoring_start", "Pembinaan mulai", "date")}{input("monitoring_end", "Pembinaan selesai", "date")}</div>
    <p className="ops-muted">Masa pembinaan dapat diatur per surat. Contoh awal enam bulan; poin tetap akumulatif setelah periode ini berakhir. Pengurangan poin dicatat terpisah.</p>
    <h3>Penerbit surat</h3><div className="ops-field-pair">{input("issue_city", "Kota penerbitan", "text", "Contoh: Palu")}{input("signer_name", "Nama penerbit / penanggung jawab")}</div>
    {input("signer_role", "Jabatan penerbit")}
    <p className="ops-muted">PDF menyediakan area tanda tangan; nama penerbit tidak dianggap sebagai tanda tangan digital. Nomor surat dibuat saat diterbitkan.</p>
    <div className="ops-form-actions"><button className="ops-button" type="submit" formNoValidate>{busy ? "Menyimpan…" : "Simpan draft & periksa PDF"}</button><button className="ops-secondary" type="button" onClick={onCancel}>Batal</button></div>
  </fieldset>{error && <p className="ops-error" role="alert">{error}</p>}</form>;
}
