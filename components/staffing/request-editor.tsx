"use client";
import { useState } from "react";
import { OperationForm } from "./operation-form";
import { addDays } from "@/lib/staffing/schedule";
import { validDate, rupiah, type StaffRequest } from "@/lib/staffing/operations-model";

export function RequestEditor({ request, onSaved, onCancel }: {
  request: StaffRequest; onSaved(request: StaffRequest): void; onCancel(): void;
}) {
  const cash = request.kind === "cash_advance";
  const [from, setFrom] = useState(request.start_date || "");
  const [to, setTo] = useState(request.end_date || "");
  const [amount, setAmount] = useState(String(request.amount || ""));
  const [units, setUnits] = useState<Record<string, number>>(() => {
    const values: Record<string, number> = {};
    if (request.start_date && request.end_date) for (let d = request.start_date, n = 0; d <= request.end_date && n < 62; d = addDays(d, 1), n++) values[d] = 0;
    for (const d of request.leave_dates) values[d.date] = Number(d.units);
    return values;
  });
  const validRange = validDate(from) && validDate(to) && to >= from && (Date.parse(to) - Date.parse(from)) / 86400000 <= 61;
  const dates: string[] = [];
  if (validRange) for (let d = from, n = 0; d <= to && n < 62; d = addDays(d, 1), n++) dates.push(d);
  const selected = dates.map(date => ({ date, units: units[date] ?? 1 })).filter(d => d.units > 0);
  const canonical = (values: typeof selected) => JSON.stringify([...values].map(d => ({ date: d.date, units: Number(d.units) })).sort((a, b) => a.date.localeCompare(b.date)));
  const dirty = cash ? Number(amount) !== Number(request.amount) : from !== request.start_date || to !== request.end_date || canonical(selected) !== canonical(request.leave_dates);
  const valid = cash ? /^[0-9]{1,13}$/.test(amount) && Number(amount) > 0 : validRange && selected.length > 0;
  const data = { request_id: request.id, revision: request.revision ?? 0, ...(cash ? { amount } : { start_date: from, end_date: to, leave_dates: selected }) };
  return <section className="ops-request-editor" aria-label="Edit pengajuan">
    <h3>Edit pengajuan</h3><p className="ops-muted">Simpan koreksi terlebih dahulu, lalu setujui setelah rinciannya benar. Nilai awal dan bukti tetap tersimpan.</p>
    <OperationForm action="amend_request" data={data} label="Simpan perubahan" submitDisabled={!dirty || !valid} onSaved={value => onSaved((value as { request: StaffRequest }).request)} actions={<button type="button" className="ops-secondary" onClick={onCancel}>Batal edit</button>}>
      {cash ? <><p className="ops-muted">Nominal saat ini: {rupiah(request.amount)}. Plafon dan pengajuan pending lain diperiksa saat disimpan.</p><label>Nominal kasbon baru<input type="number" min={1} max={1000000000000} step={1} required value={amount} onChange={event => setAmount(event.target.value)} /></label></> : <><div className="ops-field-pair"><label>Tanggal mulai<input type="date" required value={from} onChange={event => { setFrom(event.target.value); if (event.target.value > to) setTo(event.target.value); }} /></label><label>Tanggal selesai<input type="date" min={from} required value={to} onChange={event => setTo(event.target.value)} /></label></div>
        {!validRange && <p className="ops-error">Isi rentang tanggal valid, maksimal 62 hari.</p>}
        <p className="ops-muted">Total setelah koreksi: <strong>{selected.reduce((sum, d) => sum + d.units, 0)} hari</strong>. Pilih 0 untuk mengecualikan tanggal libur, atau ½ hari bila sesuai.</p>
        <div className="ops-leave-dates">{dates.map(date => <label key={date}>{date}<select aria-label={`Unit izin ${date}`} value={units[date] ?? 1} onChange={event => setUnits({ ...units, [date]: Number(event.target.value) })}><option value={0}>Tidak dihitung</option><option value={0.5}>½ hari</option><option value={1}>1 hari</option></select></label>)}</div></>}
      <label>Alasan perubahan<textarea name="note" required minLength={5} maxLength={1000} rows={2} placeholder="Jelaskan koreksi yang sudah dikonfirmasi dengan staf" /></label>
    </OperationForm>
  </section>;
}
