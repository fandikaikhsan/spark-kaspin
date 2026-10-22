"use client";

import Link from "next/link";
import styles from "./items.module.css";
import { useId, useMemo, useState, type FormEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import { BASE_UNITS, BASE_UNIT_LABELS, itemCost, parseItemInput, standardConversion, type BaseUnit, type Item, type ItemInput } from "@/lib/items/model";

const money = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 9 });
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Makassar" });

type Draft = {
  id: string; supplier: string; name: string; baseUom: BaseUnit; purchaseUnitName: string;
  purchasePrice: string; purchaseQuantity: string; purchaseConversion: string;
};

function ItemForm({ existing, busy, onCancel, onSave }: {
  existing: Item | null; busy: boolean; onCancel: () => void; onSave: (input: ItemInput) => Promise<void>;
}) {
  const unitListId = useId();
  const [draft, setDraft] = useState<Draft>(existing ? {
    id: existing.id, supplier: existing.supplier || "", name: existing.name, baseUom: existing.baseUom, purchaseUnitName: existing.purchaseUnitName,
    purchasePrice: String(existing.purchasePrice), purchaseQuantity: String(existing.purchaseQuantity),
    purchaseConversion: String(existing.purchaseConversion),
  } : { id: "", supplier: "", name: "", baseUom: "g", purchaseUnitName: "g", purchasePrice: "", purchaseQuantity: "1", purchaseConversion: "1" });
  const [error, setError] = useState<string | null>(null);
  let automaticConversion: number | null = null;
  let unitError: string | null = null;
  try { automaticConversion = standardConversion(draft.purchaseUnitName, draft.baseUom); }
  catch (error) { unitError = error instanceof Error ? error.message : "Choose a compatible unit"; }

  const preview = useMemo(() => {
    if (!draft.purchasePrice.trim() || !draft.purchaseQuantity.trim() || !draft.purchaseConversion.trim()) return null;
    try {
      return itemCost(parseItemInput({ ...draft, purchasePrice: Number(draft.purchasePrice),
        purchaseQuantity: Number(draft.purchaseQuantity), purchaseConversion: Number(draft.purchaseConversion) }));
    } catch { return null; }
  }, [draft]);

  function changeBase(baseUom: BaseUnit) {
    setDraft((previous) => {
      if (previous.purchaseUnitName.trim().toLowerCase() === previous.baseUom) {
        return { ...previous, baseUom, purchaseUnitName: baseUom, purchaseConversion: "1" };
      }
      try {
        const conversion = standardConversion(previous.purchaseUnitName, baseUom);
        return { ...previous, baseUom, purchaseConversion: conversion === null ? "" : String(conversion) };
      } catch { return { ...previous, baseUom, purchaseUnitName: baseUom, purchaseConversion: "1" }; }
    });
    setError(null);
  }

  function changePurchaseUnit(purchaseUnitName: string) {
    setDraft((previous) => {
      try {
        const conversion = standardConversion(purchaseUnitName, previous.baseUom);
        return { ...previous, purchaseUnitName, purchaseConversion: conversion === null ? "" : String(conversion) };
      } catch { return { ...previous, purchaseUnitName, purchaseConversion: "" }; }
    });
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try {
      const input = parseItemInput({ ...draft, purchasePrice: Number(draft.purchasePrice),
        purchaseQuantity: Number(draft.purchaseQuantity), purchaseConversion: Number(draft.purchaseConversion) });
      await onSave(input);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save item"); }
  }

  return <form className={`engineering-editor ${styles.editor}`} onSubmit={(event) => void submit(event)} aria-label={existing ? `Edit ${existing.name}` : "Create item"}>
    <fieldset disabled={busy}>
      <div className="engineering-section-heading"><div><p className="eyebrow">{existing ? "Edit item" : "New item"}</p><h2>{existing ? existing.name : "Add purchased stock"}</h2></div>
        <button className="engineering-secondary" type="button" onClick={onCancel}>Cancel</button></div>
      <div className={styles.formGrid}>
        <label className={styles.nameField}><span>Item name *</span><input autoFocus required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Fresh milk" /></label>
        <label><span>Item ID (optional)</span><input maxLength={80} value={draft.id} readOnly={Boolean(existing)} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="e.g. BB-001" /><small>{existing ? "ID stays fixed after creation." : "Leave blank to generate an ID. Letters, numbers, dots, hyphens, or underscores."}</small></label>
        <label><span>Base unit *</span><select value={draft.baseUom} onChange={(event) => changeBase(event.target.value as BaseUnit)}>{BASE_UNITS.map((unit) => <option key={unit} value={unit}>{BASE_UNIT_LABELS[unit]}</option>)}</select><small>The unit used to calculate quantities and costs.</small></label>
        <label><span>Purchase unit *</span><input required maxLength={80} list={unitListId} value={draft.purchaseUnitName} onChange={(event) => changePurchaseUnit(event.target.value)} placeholder="e.g. carton, bag, kg" /><datalist id={unitListId}>{[...BASE_UNITS, "bag", "pack", "bottle", "carton"].map((unit) => <option key={unit} value={unit} />)}</datalist><small>Enter a unit for this item, e.g. pack, carton, or kg.</small></label>
        <label><span>1 {draft.purchaseUnitName.trim() || "purchase unit"} contains how many {draft.baseUom}? *</span><input required type="number" min="0.000000001" max="1000000000000" step="any" readOnly={automaticConversion !== null} value={draft.purchaseConversion} onChange={(event) => setDraft({ ...draft, purchaseConversion: event.target.value })} aria-invalid={Boolean(unitError)} /><small>{automaticConversion !== null ? "Standard conversion filled automatically." : `Enter the amount in one whole ${draft.purchaseUnitName.trim() || "pack"}, measured in ${draft.baseUom}.`}</small></label>
        <label><span>Purchase quantity *</span><input required type="number" min="0.000000001" max="1000000000000" step="any" value={draft.purchaseQuantity} onChange={(event) => setDraft({ ...draft, purchaseQuantity: event.target.value })} /><small>Number of {draft.purchaseUnitName.trim() || "purchase units"} covered by the price.</small></label>
        <label><span>Reference purchase price (IDR) *</span><input required type="number" min="0" max="1000000000000" step="any" value={draft.purchasePrice} onChange={(event) => setDraft({ ...draft, purchasePrice: event.target.value })} /><small>Manager-entered costing reference. Receiving will record quantities only.</small></label>
        <label className={styles.supplierField}><span>Supplier (optional)</span><textarea maxLength={1000} rows={2} value={draft.supplier} onChange={(event) => setDraft({ ...draft, supplier: event.target.value })} placeholder="Where do we buy this item?" /></label>
      </div>
      {unitError && <p className="error" role="alert">{unitError}</p>}
      <div className={styles.costPreview} aria-live="polite">
        <div><span>Purchase covers</span><strong>{preview ? `${quantity.format(preview.quantityBase)} ${draft.baseUom}` : "—"}</strong></div>
        <div><span>Calculated cost per {draft.baseUom}</span><strong>{preview ? money.format(preview.unitCost) : "—"}</strong></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="engineering-form-actions"><span>Required fields are marked *. Blank IDs are generated automatically. Last updated is automatic.</span><button className="engineering-primary" type="submit" disabled={busy || Boolean(unitError)}>{busy ? "Saving…" : existing ? "Save changes" : "Create item"}</button></div>
    </fieldset>
  </form>;
}

async function responseError(response: Response, fallback: string) {
  if (response.status === 401) window.location.assign("/login?next=/items");
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

export function Items({ initialItems, initialError, startCreating = false }: { initialItems: Item[]; initialError: string | null; startCreating?: boolean }) {
  const [items, setItems] = useState(initialItems);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<Item | "new" | null>(startCreating && !initialError ? "new" : null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [available, setAvailable] = useState(!initialError);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState<string | null>(null);
  const needle = search.trim().toLowerCase();
  const visible = items.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(needle));

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/items", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "Could not load items"));
      const body = await response.json();
      setItems(body.items); setAvailable(true); return true;
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load items"); setAvailable(false); return false; }
    finally { setLoading(false); }
  }

  async function save(input: ItemInput) {
    setMutating(true); setMessage(null); setError(null);
    try {
      const existing = editor !== "new" ? editor : null;
      const response = await fetch(existing ? `/api/items/${encodeURIComponent(existing.id)}` : "/api/items", {
        method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not save item"));
      setEditor(null);
      const refreshed = await refresh();
      setMessage(refreshed ? `${input.name} ${existing ? "updated" : "created"}.` : "Item saved. Refresh the list to see the latest data.");
    } finally { setMutating(false); }
  }

  async function remove(item: Item) {
    setMutating(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "Could not delete item"));
      setDeleting(null);
      const refreshed = await refresh();
      setMessage(refreshed ? `${item.name} deleted.` : "Item deleted. Refresh the list to see the latest data.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete item"); }
    finally { setMutating(false); }
  }

  const disabled = loading || mutating || editor !== null || !available;
  return <main className={`shell engineering-shell ${styles.shell}`}>
    <header className="subpage-header"><div><p className="eyebrow">Spark Intelligence · Inventory</p><h1>Items</h1><p className="subtitle">Purchased stock and raw materials, shared across all stores.</p></div>
      <nav className="header-actions" aria-label="Account and navigation"><Link className="back-link" href="/">Dashboard</Link><Link className="back-link" href="/bases">Bases</Link><Link className="back-link" href="/menu-engineering">Menu engineering</Link><Link className="back-link" href="/settings">Settings</Link><LogoutButton /></nav></header>
    {error && <div className="error" role="alert">{error}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    <div className="engineering-toolbar"><label><span>Search items</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or ID" /></label>
      <div className="engineering-toolbar-actions"><button className="engineering-secondary" type="button" disabled={loading || mutating || editor !== null} onClick={() => { setMessage(null); void refresh(); }}>{loading ? "Refreshing…" : "Refresh"}</button><button className="engineering-primary" type="button" disabled={disabled} onClick={() => { setEditor("new"); setDeleting(null); setMessage(null); setError(null); }}>Create item</button></div></div>
    {editor !== null && <ItemForm key={editor === "new" ? "new" : editor.id} existing={editor === "new" ? null : editor} busy={mutating} onCancel={() => setEditor(null)} onSave={save} />}
    <section aria-label="Item catalog" aria-busy={loading}>
      <p className={styles.count}>{visible.length === items.length ? `${items.length} ${items.length === 1 ? "item" : "items"}` : `${visible.length} of ${items.length} items`}</p>
      <div className="engineering-table-wrap"><table className={`engineering-table ${styles.table}`}><thead><tr><th scope="col">Item / ID</th><th scope="col">Supplier</th><th scope="col">Reference purchase price</th><th scope="col">Purchase quantity</th><th scope="col">Conversion</th><th scope="col">Cost per base unit</th><th scope="col">Updated (WITA)</th><th scope="col">Actions</th></tr></thead>
        <tbody>{visible.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small className={styles.id}>{item.id}</small></td><td className={styles.supplierNotes}>{item.supplier || "—"}</td><td>{money.format(item.purchasePrice)}</td><td>{quantity.format(item.purchaseQuantity)} {item.purchaseUnitName}</td><td>1 {item.purchaseUnitName} = {quantity.format(item.purchaseConversion)} {item.baseUom}</td><td><strong>{money.format(itemCost(item).unitCost)} / {item.baseUom}</strong></td><td><time dateTime={item.updatedAt}>{date.format(new Date(item.updatedAt))}</time></td><td>
          <div className="engineering-row-actions"><button className="engineering-secondary" type="button" disabled={disabled} aria-label={`Edit ${item.name}`} onClick={() => { setEditor(item); setDeleting(null); setMessage(null); setError(null); }}>Edit</button><button className="engineering-delete" type="button" disabled={disabled} aria-label={`Delete ${item.name}`} onClick={() => { setDeleting(item.id); setMessage(null); setError(null); }}>Delete</button></div>
          {deleting === item.id && <div className="engineering-delete-confirm" role="group" aria-label={`Confirm deletion of ${item.name}`}><p>Delete {item.name}?</p><button className="engineering-delete" type="button" disabled={mutating} onClick={() => void remove(item)}>{mutating ? "Deleting…" : "Confirm delete"}</button><button className="engineering-secondary" type="button" disabled={mutating} onClick={() => setDeleting(null)}>Cancel</button></div>}
        </td></tr>)}
        {!visible.length && <tr><td colSpan={8} className="engineering-empty">{loading ? "Loading items…" : !available ? "Items are unavailable. Use Refresh to try again." : items.length ? "No items match your search." : "No items yet. Create your first raw material or purchased item."}</td></tr>}
      </tbody></table></div>
    </section>
  </main>;
}
