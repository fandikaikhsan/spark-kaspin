"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import {
  ITEM_TYPES, TYPE_LABELS, UNITS, calculateCost, compatibleUnits, isMenu, isPreparation,
  parseItemInput, validateReferences, type Catalog, type EngineeringItem, type ItemInput, type ItemType, type Unit,
} from "@/lib/menu-engineering/model";
import type { Store } from "@/lib/stores";

const currency = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
function money(value: number) { return currency.format(value); }
function freshItem(type: ItemType): ItemInput {
  return { type, code: "", name: "", purchasePrice: null, purchaseQuantity: null, uom: type === "raw_material" ? "kg" : null,
    supplier: null, yieldPortions: null, category: null, suggestedPrice: null, parentId: null, posItemCode: null,
    ingredients: type === "raw_material" ? [] : [{ itemId: "", quantity: 0, uom: "g" }] };
}
type Option = { id: string; label: string; detail: string };
function ItemCombo({ label, value, options, onChange }: {
  label: string; value: string; options: Option[]; onChange(value: string): void;
}) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find((option) => option.id === value);
  const filtered = options.filter((option) => `${option.label} ${option.detail}`.toLowerCase().includes((query || "").toLowerCase())).slice(0, 50);
  function choose(option: Option) { onChange(option.id); setQuery(null); setOpen(false); }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setOpen(true);
      setActive((current) => Math.max(0, Math.min(filtered.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && open) {
      event.preventDefault(); if (filtered[active]) choose(filtered[active]);
    } else if (event.key === "Escape") { setOpen(false); setQuery(null); }
  }
  return <div className="engineering-combo" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(null); }
  }}>
    <label className="sr-only" htmlFor={id}>{label}</label>
    <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`}
      aria-activedescendant={open && filtered[active] ? `${id}-option-${active}` : undefined}
      autoComplete="off" required placeholder="Type to search…" value={query ?? selected?.label ?? ""}
      onFocus={() => { setOpen(true); setActive(0); }} onKeyDown={keyDown}
      onChange={(event) => { setQuery(event.target.value); onChange(""); setOpen(true); setActive(0); }} />
    {open && <ul className="engineering-options" role="listbox" id={`${id}-options`} aria-label={label}>
      {filtered.map((option, index) => <li key={option.id} id={`${id}-option-${index}`} role="option"
        aria-selected={option.id === value} className={active === index ? "is-active" : ""}
        onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
        <strong>{option.label}</strong><small>{option.detail}</small>
      </li>)}
      {!filtered.length && <li role="presentation">No matching items. Create the ingredient first.</li>}
    </ul>}
  </div>;
}
function CostPreview({ item, items }: { item: ItemInput; items: EngineeringItem[] }) {
  try {
    if (item.type !== "raw_material" && (!item.ingredients.length || item.ingredients.some((row) => !row.itemId || row.quantity <= 0))) {
      throw new Error("Choose ingredients and enter quantities to preview costs.");
    }
    const cost = calculateCost(item, items);
    return <div className="engineering-costs" aria-live="polite">
      {isPreparation(item.type) && <><div><span>Ingredient subtotal</span><strong>{money(cost.ingredientCost)}</strong></div>
        <div><span>Production allowance · 5%</span><strong>{money(cost.overhead)}</strong></div></>}
      <div><span>{item.type === "raw_material" ? "Purchase cost" : "Total production cost"}</span><strong>{money(cost.totalProductionCost)}</strong></div>
      {(isPreparation(item.type) || item.type === "raw_material") && <div className="cost-highlight"><span>{isPreparation(item.type) ? "Price per portion" : `Cost per ${item.uom}`}</span><strong>{money(cost.unitCost)}</strong></div>}
      {isMenu(item.type) && <>
        <div><span>Cost percentage</span><strong>{cost.costPercentage === null ? "—" : `${decimal.format(cost.costPercentage)}%`}</strong></div>
        <div className={`cost-highlight ${cost.margin !== null && cost.margin < 0 ? "cost-negative" : ""}`}><span>Margin</span><strong>{cost.margin === null ? "—" : money(cost.margin)}{cost.marginPercentage !== null && <small>{decimal.format(cost.marginPercentage)}%</small>}</strong></div>
      </>}
    </div>;
  } catch (error) { return <p className="engineering-hint" aria-live="polite">{error instanceof Error ? error.message : "Complete the required fields to preview costs."}</p>; }
}
function ItemForm({ existing, items, categories, storeId, onSaved, onCancel }: {
  existing?: EngineeringItem; items: EngineeringItem[]; categories: string[]; storeId: string;
  onSaved(): Promise<void>; onCancel(): void;
}) {
  const router = useRouter();
  const [item, setItem] = useState<ItemInput>(existing || freshItem("menu_item"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categoryId = useId();
  const raw = item.type === "raw_material";
  const prep = isPreparation(item.type);
  const menu = isMenu(item.type);
  const candidates = items.filter((entry) => entry.id !== existing?.id && (entry.type === "raw_material" || (menu && isPreparation(entry.type))));
  const parents = items.filter((entry) => entry.type === "menu_item");
  const options = candidates.map((entry) => ({ id: entry.id, label: entry.name, detail: `${TYPE_LABELS[entry.type]} · ${entry.code} · ${entry.uom || "porsi"}` }));
  function field<K extends keyof ItemInput>(key: K, value: ItemInput[K]) { setItem((current) => ({ ...current, [key]: value })); }
  function numberField(key: "purchasePrice" | "purchaseQuantity" | "yieldPortions" | "suggestedPrice", value: string) {
    field(key, value === "" ? null : Number(value));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try {
      const input = parseItemInput(item);
      validateReferences(input, items, existing?.id);
      setSaving(true);
      const response = await fetch(existing ? `/api/menu-engineering/${existing.id}` : "/api/menu-engineering", {
        method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storeId, item: input }),
      });
      const payload = await response.json();
      if (response.status === 401) window.location.assign("/login?next=/menu-engineering");
      if (!response.ok) throw new Error(payload.error || "Could not save item");
      await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save item"); }
    finally { setSaving(false); }
  }
  return <form className="engineering-editor" onSubmit={submit}>
    <div className="engineering-section-heading"><div><p className="eyebrow">{existing ? "Edit catalog" : "Recipe entry"}</p><h2>{existing ? existing.name : "Create a recipe"}</h2></div>
      <button type="button" className="engineering-secondary" onClick={onCancel} disabled={saving}>Close</button></div>
    <fieldset disabled={saving}>
      <div className="engineering-fields">
        <label><span>Item type *</span><select value={raw ? "raw_material" : prep ? "base" : "menu_item"} disabled={Boolean(existing)} onChange={(event) => {
          if (event.target.value === "raw_material") { router.push("/items?create=1"); return; }
          if (event.target.value === "base") { router.push("/bases?create=1"); return; }
          setItem(freshItem(event.target.value as ItemType)); setError(null);
        }}>
          <option value="raw_material">Raw material</option><option value="base">Base / add-on</option><option value="menu_item">Menu item / variant</option>
        </select></label>
        {!raw && <label><span>{prep ? "Preparation type" : "Is this a variant?"}</span><select value={item.type} disabled={Boolean(existing)} onChange={(event) => setItem(freshItem(event.target.value as ItemType))}>
          {prep ? <><option value="base">Base</option><option value="addon">Add-on</option></> : <><option value="menu_item">No · main menu item</option><option value="variant">Yes · variant</option></>}
        </select></label>}
        <label><span>Name *</span><input required maxLength={200} value={item.name} onChange={(event) => field("name", event.target.value)} placeholder={raw ? "Fresh milk" : prep ? "Vanilla syrup" : "Iced vanilla latte"} /></label>
        {raw && <>
          <label><span>Material ID *</span><input required maxLength={80} value={item.code} onChange={(event) => field("code", event.target.value)} placeholder="RM-001" /></label>
          <label><span>Purchase price (IDR) *</span><input required type="number" min="0" max="1000000000000" step="any" value={item.purchasePrice ?? ""} onChange={(event) => numberField("purchasePrice", event.target.value)} /></label>
          <label><span>Purchase quantity *</span><input required type="number" min="0.000001" max="1000000000000" step="any" value={item.purchaseQuantity ?? ""} onChange={(event) => numberField("purchaseQuantity", event.target.value)} /></label>
          <label><span>Purchase UOM *</span><select value={item.uom || "kg"} onChange={(event) => field("uom", event.target.value as Unit)}>{UNITS.filter((unit) => unit !== "porsi").map((unit) => <option key={unit}>{unit}</option>)}</select></label>
          <label><span>Supplier <small>Optional</small></span><input maxLength={200} value={item.supplier || ""} onChange={(event) => field("supplier", event.target.value || null)} placeholder="Supplier name" /></label>
        </>}
        {prep && <label><span>Yield (porsi) *</span><input required type="number" min="0.000001" max="1000000000000" step="any" value={item.yieldPortions ?? ""} onChange={(event) => numberField("yieldPortions", event.target.value)} /></label>}
        {item.type === "variant" && <div className="engineering-field"><span>Main menu item *</span><ItemCombo label="Main menu item" value={item.parentId || ""} options={parents.map((entry) => ({ id: entry.id, label: entry.name, detail: entry.code }))} onChange={(value) => field("parentId", value || null)} /></div>}
        {menu && <>
          <label><span>Category *</span><input required maxLength={200} list={categoryId} value={item.category || ""} onChange={(event) => field("category", event.target.value)} placeholder="Choose or enter a category" /><datalist id={categoryId}>{categories.map((category) => <option value={category} key={category} />)}</datalist></label>
          <label><span>Suggested price (IDR) *</span><input required type="number" min="0.000001" max="1000000000000" step="any" value={item.suggestedPrice ?? ""} onChange={(event) => numberField("suggestedPrice", event.target.value)} /></label>
          <label><span>KasirPintar item code <small>Optional</small></span><input maxLength={200} value={item.posItemCode || ""} onChange={(event) => field("posItemCode", event.target.value || null)} placeholder="Link this recipe to a POS product" /></label>
        </>}
      </div>
      {!raw && <section className="engineering-ingredients" aria-label="Recipe ingredients">
        <div className="engineering-section-heading"><div><h3>Ingredients *</h3><p>{prep ? "Choose at least one raw material. Quantities are for the whole batch." : "Choose raw materials, bases, or add-ons. Quantities are for one menu item."}</p></div></div>
        {candidates.length === 0 && <div className="notice">Create a raw material first so you can build a recipe.</div>}
        <div className="engineering-recipe-header" aria-hidden="true"><span>Ingredient</span><span>Quantity</span><span>UOM</span><span>Cost</span><span /></div>
        {item.ingredients.map((row, index) => {
          const ingredient = candidates.find((entry) => entry.id === row.itemId);
          const units = ingredient ? compatibleUnits(ingredient.uom || "porsi") : UNITS;
          let lineCost: number | null = null;
          try { if (ingredient && row.quantity > 0) lineCost = calculateCost({ ...freshItem("menu_item"), ingredients: [row] }, items).totalProductionCost; } catch { /* Incomplete input has no preview. */ }
          function updateRow(updates: Partial<typeof row>) { field("ingredients", item.ingredients.map((entry, position) => position === index ? { ...entry, ...updates } : entry)); }
          return <div className="engineering-recipe-row" key={index}>
            <ItemCombo label={`Ingredient ${index + 1}`} value={row.itemId} options={options.filter((option) => option.id === row.itemId || !item.ingredients.some((entry) => entry.itemId === option.id))} onChange={(id) => {
              const selected = candidates.find((entry) => entry.id === id);
              const defaultUnit = selected?.uom || "porsi";
              updateRow({ itemId: id, uom: selected && compatibleUnits(defaultUnit).includes(row.uom) ? row.uom : defaultUnit });
            }} />
            <input aria-label={`Quantity for ingredient ${index + 1}`} required type="number" min="0.000001" max="1000000000000" step="any" value={row.quantity || ""} onChange={(event) => updateRow({ quantity: Number(event.target.value) })} />
            <select aria-label={`Unit for ingredient ${index + 1}`} value={row.uom} onChange={(event) => updateRow({ uom: event.target.value as Unit })}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select>
            <span className="engineering-line-cost">{lineCost === null ? "—" : money(lineCost)}</span>
            <button type="button" className="engineering-remove" disabled={item.ingredients.length === 1} aria-label={`Remove ingredient ${index + 1}`} onClick={() => field("ingredients", item.ingredients.filter((_, position) => position !== index))}>×</button>
          </div>;
        })}
        <button type="button" className="engineering-secondary" disabled={item.ingredients.length >= 200} onClick={() => field("ingredients", [...item.ingredients, { itemId: "", quantity: 0, uom: "g" }])}>+ Add ingredient</button>
      </section>}
      <CostPreview item={item} items={items} />
      {menu && <p className="engineering-hint">Margin = suggested price − production cost. Each variant has its own complete recipe and price.</p>}
      {raw && <p className="engineering-hint">Purchase price is the total price for the entered quantity. Recipes convert compatible units automatically.</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="engineering-form-actions"><span>* Required fields</span><button className="engineering-primary" type="submit" disabled={saving || (!raw && !candidates.length) || (item.type === "variant" && !parents.length)}>{saving ? "Saving…" : existing ? "Save changes" : "Create recipe"}</button></div>
    </fieldset>
  </form>;
}

export function MenuEngineering({ stores, initialCatalog, initialError, initialStoreId }: {
  stores: Store[]; initialCatalog: Catalog; initialError: string | null; initialStoreId?: string;
}) {
  const [storeId, setStoreId] = useState(initialStoreId || stores[0]?.id || "");
  const [catalog, setCatalog] = useState(initialCatalog);
  const [error, setError] = useState(initialError);
  const [catalogUnavailable, setCatalogUnavailable] = useState(Boolean(initialError));
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<EngineeringItem | "new" | null>(null);
  const [filter, setFilter] = useState<ItemType | "all">("all");
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const requestSequence = useRef(0);
  async function refresh(nextStoreId = storeId) {
    const sequence = ++requestSequence.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/menu-engineering?store=${encodeURIComponent(nextStoreId)}`, { cache: "no-store" });
      if (response.status === 401) window.location.assign("/login?next=/menu-engineering");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load catalog");
      if (sequence === requestSequence.current) { setCatalog(payload as Catalog); setCatalogUnavailable(false); }
    } catch (error) {
      if (sequence === requestSequence.current) { setError(error instanceof Error ? error.message : "Could not load catalog"); setCatalogUnavailable(true); }
    } finally { if (sequence === requestSequence.current) setLoading(false); }
  }
  async function remove(item: EngineeringItem) {
    setBusyDelete(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/menu-engineering/${item.id}?store=${encodeURIComponent(storeId)}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json();
        if (response.status === 401) window.location.assign("/login?next=/menu-engineering");
        throw new Error(payload.error || "Could not delete item");
      }
      setDeleting(null); setMessage(`${item.name} deleted.`); await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete item"); }
    finally { setBusyDelete(false); }
  }
  const visible = catalog.items.filter((item) => (filter === "all" || filter === item.type) && `${item.name} ${item.code} ${item.category || ""} ${item.supplier || ""}`.toLowerCase().includes(search.toLowerCase()));
  return <main className="shell engineering-shell">
    <header className="subpage-header"><div><p className="eyebrow">Spark Intelligence · Administration</p><h1>Menu engineering</h1><p className="subtitle">Build the ingredients and recipes behind your menu costs.</p></div>
      <nav className="header-actions" aria-label="Account and navigation"><Link className="back-link" href="/items">Items</Link><Link className="back-link" href="/bases">Bases</Link><Link className="back-link" href="/">Dashboard</Link><Link className="back-link" href="/settings">Settings</Link><LogoutButton /></nav></header>
    {!stores.length ? <div className="notice">Add a store in <Link href="/settings">Settings</Link> before creating a catalog.</div> : <>
      <section className="engineering-toolbar" aria-label="Catalog controls"><label><span>Store</span><select value={storeId} disabled={editor !== null || busyDelete} onChange={(event) => {
        const next = event.target.value; setStoreId(next); setCatalog({ items: [], categories: [] }); setDeleting(null); setMessage(null);
        window.history.replaceState(null, "", `/menu-engineering?store=${encodeURIComponent(next)}`); void refresh(next);
      }}>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}{store.active ? "" : " (inactive)"}</option>)}</select></label>
        <div className="engineering-toolbar-actions"><Link className="engineering-secondary engineering-action-link" href="/items?create=1">+ Create item</Link><Link className="engineering-secondary engineering-action-link" href="/bases?create=1">+ Create base</Link><button type="button" className="engineering-secondary" disabled={loading || editor !== null || busyDelete} onClick={() => void refresh()}>Refresh</button><button type="button" className="engineering-primary" disabled={loading || catalogUnavailable || busyDelete || editor !== null} onClick={() => { setEditor("new"); setDeleting(null); setMessage(null); setError(null); }}>+ Create recipe</button></div></section>
      <div className="engineering-summary">{[
        { label: "Raw materials", count: catalog.items.filter((item) => item.type === "raw_material").length },
        { label: "Bases & add-ons", count: catalog.items.filter((item) => isPreparation(item.type)).length },
        { label: "Menu items & variants", count: catalog.items.filter((item) => isMenu(item.type)).length },
      ].map((stat) => <div key={stat.label}><span>{stat.label}</span><strong>{stat.count}</strong></div>)}<p>Recipe costs update from current material prices.<br />Bases and add-ons include a 5% production allowance.</p></div>
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {loading && <p role="status">Loading catalog…</p>}
      {editor !== null && <ItemForm key={editor === "new" ? "new" : editor.id} existing={editor === "new" ? undefined : editor} items={catalog.items} categories={catalog.categories} storeId={storeId} onCancel={() => setEditor(null)} onSaved={async () => {
        setEditor(null); setMessage(editor === "new" ? "Recipe created." : "Item updated. Dependent recipe costs have been recalculated."); await refresh();
      }} />}
      <section className="engineering-catalog" aria-label="Item catalog" aria-busy={loading}>
        <div className="engineering-section-heading"><div><h2>Item catalog</h2><p>{visible.length} of {catalog.items.length} items</p></div><label className="engineering-search"><span className="sr-only">Search catalog</span><input type="search" placeholder="Search name, ID, category…" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
        <div className="engineering-tabs" aria-label="Filter by item type">{(["all", ...ITEM_TYPES] as const).map((type) => <button key={type} type="button" aria-pressed={filter === type} onClick={() => setFilter(type)}>{type === "all" ? "All items" : TYPE_LABELS[type]}</button>)}</div>
        <div className="engineering-table-wrap"><table className="engineering-table"><thead><tr><th>Item</th><th>Type</th><th>Details</th><th>Unit / production cost</th><th>Margin</th><th>Actions</th></tr></thead><tbody>
          {visible.map((item) => {
            let cost: ReturnType<typeof calculateCost> | null = null;
            try { cost = calculateCost(item, catalog.items); } catch { /* Display incomplete legacy data explicitly. */ }
            const usedBy = catalog.items.filter((other) => other.parentId === item.id || other.ingredients.some((row) => row.itemId === item.id));
            return <tr key={item.id}><td><strong>{item.name}</strong><small className="engineering-item-code">{item.code}</small>{item.type === "variant" && <small>Variant of {catalog.items.find((entry) => entry.id === item.parentId)?.name || "missing menu item"}</small>}</td>
              <td><span className="engineering-type">{TYPE_LABELS[item.type]}</span></td><td>{item.type === "raw_material" ? <>{decimal.format(item.purchaseQuantity || 0)} {item.uom} · {money(item.purchasePrice || 0)}<small>{item.supplier || "No supplier"}</small></> : <>{item.ingredients.length} ingredients<small>{isPreparation(item.type) ? `Yield ${decimal.format(item.yieldPortions || 0)} porsi` : item.category}</small>{isMenu(item.type) && <small>Price {money(item.suggestedPrice || 0)}</small>}</>}</td>
              <td>{cost ? <>{money(item.type === "raw_material" || isPreparation(item.type) ? cost.unitCost : cost.totalProductionCost)}<small>{item.type === "raw_material" ? `per ${item.uom}` : isPreparation(item.type) ? "per porsi" : cost.costPercentage === null ? "" : `${decimal.format(cost.costPercentage)}% of price`}</small></> : <span className="engineering-invalid">Check recipe</span>}</td>
              <td className={cost?.margin !== null && (cost?.margin || 0) < 0 ? "engineering-invalid" : ""}>{cost?.margin != null ? <>{money(cost.margin)}<small>{decimal.format(cost.marginPercentage!)}%</small></> : "—"}</td>
              <td><div className="engineering-row-actions"><button type="button" className="engineering-secondary" disabled={loading || editor !== null || busyDelete || catalogUnavailable} onClick={() => { setEditor(item); setDeleting(null); setMessage(null); setError(null); }}>Edit</button><button type="button" className="engineering-delete" disabled={loading || editor !== null || busyDelete || catalogUnavailable || usedBy.length > 0} title={usedBy.length ? `Used by ${usedBy.map((entry) => entry.name).join(", ")}` : `Delete ${item.name}`} onClick={() => { setDeleting(item.id); setMessage(null); setError(null); }}>Delete</button></div>
                {usedBy.length > 0 && <small>Used by {usedBy.length} {usedBy.length === 1 ? "item" : "items"}</small>}
                {deleting === item.id && <div className="engineering-delete-confirm" role="group" aria-label={`Confirm deletion of ${item.name}`}><p>Delete {item.name}?</p><button className="engineering-delete" type="button" disabled={busyDelete} onClick={() => void remove(item)}>{busyDelete ? "Deleting…" : "Confirm delete"}</button><button type="button" className="engineering-secondary" disabled={busyDelete} onClick={() => setDeleting(null)}>Cancel</button></div>}
              </td></tr>;
          })}
          {!visible.length && <tr><td colSpan={6} className="engineering-empty">{loading ? "Loading…" : catalog.items.length ? "No items match your search." : "Your catalog is empty. Start by creating your first raw material."}</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </main>;
}
