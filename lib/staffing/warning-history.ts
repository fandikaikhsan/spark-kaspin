import { pointKindLabels, type WarningOverview, type WarningRow } from './warning-model';
export type WarningHistoryRow = {
  id: string; at: string; kind: string; description: string; change: number | null; balance: number | null;
  warning: WarningRow | null; status: 'draft' | 'issued' | 'revoked' | 'recorded';
};
export function warningHistory(data: WarningOverview): WarningHistoryRow[] {
  const letters = new Map(data.warnings.map(warning => [warning.id, warning]));
  const drafts: WarningHistoryRow[] = data.warnings.filter(warning => warning.status === 'draft').map(warning => ({
    id: `draft:${warning.id}`, at: warning.created_at, kind: `Draft SP${warning.level}`,
    description: warning.subject || 'Perihal belum diisi', change: null, balance: null, warning, status: 'draft',
  }));
  const entries: WarningHistoryRow[] = data.ledger.map(entry => {
    const warning = entry.warning_id ? letters.get(entry.warning_id) || null : null;
    return { id: entry.id, at: entry.created_at, kind: pointKindLabels[entry.entry_kind] || 'Catatan SP lama',
      description: entry.reason, change: entry.points, balance: entry.context.after ?? null,
      warning, status: warning?.status || 'recorded' };
  });
  const newest = (a: WarningHistoryRow, b: WarningHistoryRow) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
  return [...drafts.sort(newest), ...entries.sort(newest)];
}
