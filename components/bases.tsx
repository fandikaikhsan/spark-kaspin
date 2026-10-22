"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import { BaseIngredientPicker } from "@/components/base-ingredient-picker";
import { OUTPUT_UNITS, OUTPUT_LABELS, baseCost, ingredientUnits, parseBaseInput, type BaseInput, type OutputUnit, type PreparedBase } from "@/lib/bases/model";
import type { Item } from "@/lib/items/model";
import styles from "./items.module.css";
import recipeStyles from "./bases.module.css";
const money = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 9 });
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Makassar" });
type DraftLine = { key: number; itemId: string; quantity: string; uom: string };
function BaseForm({ existing, items, busy, onCancel, onSave }: { existing: PreparedBase | null; items: Item[]; busy: boolean; onCancel(): void; onSave(input: BaseInput): Promise<void> }) {
  const [id, setId] = useState(existing?.id || "");
  const [name, setName] = useState(existing?.name || "");
  const [unit, setUnit] = useState<OutputUnit>(existing?.baseUom || "porsi");
  const [yieldQuantity, setYield] = useState(existing ? String(existing.yieldQuantity) : "");
  const [lines, setLines] = useState<DraftLine[]>(existing ? existing.ingredients.map((row, key) => ({ ...row, key, quantity: String(row.quantity) })) : [{ key: 0, itemId: "", quantity: "", uom: "g" }]);
  const [nextKey, setNextKey] = useState(lines.length);
  const [error, setError] = useState<string | null>(null);
  const input = () => parseBaseInput({ id, name, baseUom: unit, yieldQuantity: Number(yieldQuantity), ingredients: lines.map((row) => ({ ...row, quantity: Number(row.quantity) })) });
  let preview: ReturnType<typeof baseCost> | null = null;
  try { preview = baseCost(input(), items); } catch { /* Incomplete fields have no preview. */ }
  function update(key: number, change: Partial<DraftLine>) { setLines((previous) => previous.map((row) => row.key === key ? { ...row, ...change } : row)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try { const value = input(); baseCost(value, items); await onSave(value); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not save base"); }
  }
  return <form className={`engineering-editor ${styles.editor}`} onSubmit={(event) => void submit(event)} aria-label={existing ? `Edit ${existing.name}` : "Create base"}><fieldset disabled={busy}>
    <div className="engineering-section-heading"><div><p className="eyebrow">{existing ? "Edit base" : "New base"}</p><h2>{existing ? existing.name : "Add a prepared base"}</h2></div><button className="engineering-secondary" type="button" onClick={onCancel}>Cancel</button></div>
    <div className={styles.formGrid}>
      <label><span>Base name *</span><input autoFocus required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Base Carbonara" /></label>
      <label><span>Base ID (optional)</span><input maxLength={80} readOnly={Boolean(existing)} value={id} onChange={(event) => setId(event.target.value)} placeholder="e.g. BASE-001" /><small>{existing ? "ID stays fixed after creation." : "Leave blank to generate an ID. Letters, numbers, dots, hyphens, or underscores."}</small></label>
      <label><span>Base unit *</span><select value={unit} onChange={(event) => setUnit(event.target.value as OutputUnit)}>{OUTPUT_UNITS.map((uom) => <option key={uom} value={uom}>{OUTPUT_LABELS[uom]}</option>)}</select><small>Use the unit you prepare and count this base in.</small></label>
      <label className={recipeStyles.yield}><span>Batch yield ({unit}) *</span><input required type="number" min="0.000000001" max="1000000000000" step="any" value={yieldQuantity} onChange={(event) => setYield(event.target.value)} placeholder="e.g. 22" /><small>Finished output from one batch. Changing the unit does not convert the quantity.</small></label>
    </div>
    <section className={recipeStyles.ingredients} aria-label="Recipe ingredients"><h3>Ingredients *</h3><p className={recipeStyles.hint}>Enter the raw materials used for the whole batch. At least one is required.</p>
      {!items.length && <p className="notice">Add a raw material in <Link href="/items?create=1">Items</Link> before saving a base.</p>}
      {lines.map((row, index) => {
        const item = items.find((entry) => entry.id === row.itemId);
        let lineCost: number | null = null;
        try { if (row.itemId && Number(row.quantity) > 0) lineCost = baseCost({ ingredients: [{ itemId: row.itemId, quantity: Number(row.quantity), uom: row.uom }], yieldQuantity: 1 }, items).ingredientCost; } catch { /* Invalid selection has no cost. */ }
        return <div className={recipeStyles.row} key={row.key}>
          <div className={`${recipeStyles.field} ${recipeStyles.ingredient}`}><span>Raw material {index + 1} *</span><BaseIngredientPicker label={`Ingredient ${index + 1}`} value={row.itemId} items={items} onChange={(itemId) => { const chosen = items.find((item) => item.id === itemId); update(row.key, { itemId, ...(chosen ? { uom: chosen.baseUom } : {}) }); }} /></div>
          <label className={recipeStyles.field}><span>Quantity *</span><input aria-label={`Quantity for ingredient ${index + 1}`} required type="number" min="0.000000001" max="1000000000000" step="any" value={row.quantity} onChange={(event) => update(row.key, { quantity: event.target.value })} /></label>
          <label className={recipeStyles.field}><span>Unit *</span><select aria-label={`Unit for ingredient ${index + 1}`} value={row.uom} onChange={(event) => update(row.key, { uom: event.target.value })}>{(item ? ingredientUnits(item) : [row.uom]).map((uom) => <option key={uom} value={uom}>{uom}</option>)}</select></label>
          <div className={recipeStyles.lineCost}><span>Cost</span><strong>{lineCost === null ? "—" : money.format(lineCost)}</strong></div>
          <button className={`engineering-remove ${recipeStyles.remove}`} type="button" disabled={lines.length === 1} aria-label={`Remove ingredient ${index + 1}`} onClick={() => setLines(lines.filter((line) => line.key !== row.key))}>×</button>
        </div>;
      })}
      <button className="engineering-secondary" type="button" disabled={lines.length >= 200 || !items.length} onClick={() => { setLines([...lines, { key: nextKey, itemId: "", quantity: "", uom: "g" }]); setNextKey(nextKey + 1); }}>+ Add ingredient</button>
    </section>
    <div className={`${styles.costPreview} ${recipeStyles.costs}`} aria-live="polite">{[
      ["Ingredient subtotal", preview?.ingredientCost], ["Production allowance · 5%", preview?.overhead],
      ["Total production cost", preview?.totalProductionCost], [`Cost per ${unit}`, preview?.unitCost],
    ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{typeof value === "number" ? money.format(value) : "—"}</strong></div>)}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="engineering-form-actions"><span>* Required fields. The base and its recipe save together.</span><button className="engineering-primary" type="submit" disabled={busy || !items.length}>{busy ? "Saving…" : existing ? "Save changes" : "Create base"}</button></div>
  </fieldset></form>;
}
async function responseError(response: Response, fallback: string) {
  if (response.status === 401) window.location.assign("/login?next=/bases");
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}
export function Bases({ initialBases, initialItems, initialError, startCreating = false }: { initialBases: PreparedBase[]; initialItems: Item[]; initialError: string | null; startCreating?: boolean }) {
  const [bases, setBases] = useState(initialBases); const [items, setItems] = useState(initialItems);
  const [search, setSearch] = useState(""); const [editor, setEditor] = useState<PreparedBase | "new" | null>(startCreating && !initialError ? "new" : null);
  const [deleting, setDeleting] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [mutating, setMutating] = useState(false);
  const [available, setAvailable] = useState(!initialError); const [error, setError] = useState(initialError); const [message, setMessage] = useState<string | null>(null);
  const visible = bases.filter((base) => `${base.name} ${base.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  async function refresh() {
    setLoading(true); setError(null);
    try { const response = await fetch("/api/bases", { cache: "no-store" }); if (!response.ok) throw new Error(await responseError(response, "Could not load bases"));
      const data = await response.json(); setBases(data.bases); setItems(data.items); setAvailable(true); return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load bases"); setAvailable(false); return false; }
    finally { setLoading(false); }
  }
  async function save(input: BaseInput) {
    setMutating(true); setMessage(null); setError(null);
    try {
      const existing = editor !== "new" ? editor : null;
      const response = await fetch(existing ? `/api/bases/${encodeURIComponent(existing.id)}` : "/api/bases", { method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(await responseError(response, "Could not save base"));
      setEditor(null); const refreshed = await refresh();
      setMessage(refreshed ? `${input.name} ${existing ? "updated" : "created"}.` : "Base saved. Refresh to see the latest data.");
    } finally { setMutating(false); }
  }
  async function remove(base: PreparedBase) {
    setMutating(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/bases/${encodeURIComponent(base.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "Could not delete base"));
      setDeleting(null); const refreshed = await refresh(); setMessage(refreshed ? `${base.name} deleted.` : "Base deleted. Refresh to see the latest data.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete base"); }
    finally { setMutating(false); }
  }
  const disabled = loading || mutating || editor !== null || !available;
  return <main className={`shell engineering-shell ${styles.shell}`}>
    <header className="subpage-header"><div><p className="eyebrow">Spark Intelligence · Catalog & recipes</p><h1>Bases</h1><p className="subtitle">Prepared stock and its recipes, shared across all stores.</p></div><nav className="header-actions" aria-label="Account and navigation"><Link className="back-link" href="/items">Items</Link><Link className="back-link" href="/">Dashboard</Link><Link className="back-link" href="/products">Products</Link><Link className="back-link" href="/stock-opname">Stock Opname</Link><Link className="back-link" href="/receiving">Receiving</Link><Link className="back-link" href="/settings">Settings</Link><LogoutButton /></nav></header>
    {error && <div className="error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="engineering-toolbar"><label><span>Search bases</span><input type="search" placeholder="Search by name or ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="engineering-toolbar-actions"><button className="engineering-secondary" type="button" disabled={loading || mutating || editor !== null} onClick={() => { setMessage(null); void refresh(); }}>{loading ? "Refreshing…" : "Refresh"}</button><button className="engineering-primary" type="button" disabled={disabled} onClick={() => { setEditor("new"); setDeleting(null); setMessage(null); setError(null); }}>Create base</button></div></div>
    {editor !== null && <BaseForm key={editor === "new" ? "new" : editor.id} existing={editor === "new" ? null : editor} items={items} busy={mutating} onCancel={() => setEditor(null)} onSave={save} />}
    <section aria-label="Base catalog" aria-busy={loading}><p className={styles.count}>{visible.length === bases.length ? `${bases.length} ${bases.length === 1 ? "base" : "bases"}` : `${visible.length} of ${bases.length} bases`}</p>
      <div className="engineering-table-wrap"><table className={`engineering-table ${styles.table}`}><thead><tr>{["Base / ID", "Batch yield", "Ingredients", "Production cost", "Cost per unit", "Updated (WITA)", "Actions"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>
        {visible.map((base) => { let cost: ReturnType<typeof baseCost> | null = null; try { cost = baseCost(base, items); } catch { /* Show a refresh hint instead of an incorrect cost. */ }
          return <tr key={base.id}><td><strong>{base.name}</strong><small className={styles.id}>{base.id}</small></td><td>{quantity.format(base.yieldQuantity)} {base.baseUom}</td><td>{base.ingredients.length} raw materials</td><td>{cost ? money.format(cost.totalProductionCost) : "Refresh required"}<small>Includes 5% allowance</small></td><td><strong>{cost ? money.format(cost.unitCost) : "—"} / {base.baseUom}</strong></td><td><time dateTime={base.updatedAt}>{date.format(new Date(base.updatedAt))}</time></td><td><div className="engineering-row-actions"><button className="engineering-secondary" type="button" disabled={disabled} aria-label={`Edit ${base.name}`} onClick={() => { setEditor(base); setDeleting(null); setMessage(null); setError(null); }}>Edit</button><button className="engineering-delete" type="button" disabled={disabled} aria-label={`Delete ${base.name}`} onClick={() => { setDeleting(base.id); setMessage(null); setError(null); }}>Delete</button></div>
            {deleting === base.id && <div className="engineering-delete-confirm" role="group" aria-label={`Confirm deletion of ${base.name}`}><p>Delete {base.name} and its recipe?</p><button className="engineering-delete" type="button" disabled={mutating} onClick={() => void remove(base)}>{mutating ? "Deleting…" : "Confirm delete"}</button><button className="engineering-secondary" type="button" disabled={mutating} onClick={() => setDeleting(null)}>Cancel</button></div>}
          </td></tr>;
        })}
        {!visible.length && <tr><td colSpan={7} className="engineering-empty">{loading ? "Loading bases…" : !available ? "Bases are unavailable. Use Refresh to try again." : bases.length ? "No bases match your search." : "No bases yet. Create your first prepared base and recipe."}</td></tr>}
      </tbody></table></div>
    </section>
  </main>;
}
