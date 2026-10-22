"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LogoutButton } from "@/components/logout-button";
import { ProductIngredientPicker, type ProductIngredientOption } from "@/components/product-ingredient-picker";
import { PRODUCT_TYPES, PRODUCT_LABELS, parseProductInput, parseCategoryName, productCost, productIngredientUnits, type Product, type ProductInput, type ProductIngredient, type ProductType, type Category, type ProductCatalog } from "@/lib/products/model";
import styles from "./items.module.css";
import recipeStyles from "./bases.module.css";
import productStyles from "./products.module.css";
const money = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Makassar" });
type DraftLine = { key: number; kind: "item" | "base"; ingredientId: string; quantity: string; uom: string };
function ProductForm({ existing, catalog, busy, onCancel, onSave, onCategory }: { existing: Product | null; catalog: ProductCatalog; busy: boolean; onCancel(): void; onSave(input: ProductInput): Promise<void>; onCategory(name: string): Promise<Category> }) {
  const [id, setId] = useState(existing?.id || ""); const [name, setName] = useState(existing?.name || "");
  const [type, setType] = useState<ProductType>(existing?.type || "menu"); const [parent, setParent] = useState(existing?.parentProductId || "");
  const [categoryId, setCategoryId] = useState(existing?.categoryId || ""); const [price, setPrice] = useState(existing ? String(existing.salesPrice) : "");
  const [addingCategory, setAddingCategory] = useState(false); const [categoryName, setCategoryName] = useState(""); const [categoryBusy, setCategoryBusy] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>(existing ? existing.ingredients.map((row, key) => ({ ...row, key, quantity: String(row.quantity) })) : [{ key: 0, kind: "item", ingredientId: "", quantity: "", uom: "g" }]);
  const [nextKey, setNextKey] = useState(lines.length); const [error, setError] = useState<string | null>(null);
  const parents = catalog.products.filter((product) => product.type === "menu" && product.id !== existing?.id);
  const options: ProductIngredientOption[] = [
    ...catalog.items.map((item) => ({ id: `item:${item.id}`, name: item.name, typeLabel: "Raw material", detail: `Raw material · ${item.id} · ${item.baseUom}` })),
    ...catalog.bases.map((base) => ({ id: `base:${base.id}`, name: base.name, typeLabel: "Base", detail: `Base · ${base.id} · ${base.baseUom}` })),
  ];
  function input() { return parseProductInput({ id, name, type, parentProductId: type === "variant" ? parent : null, categoryId: categoryId || null, salesPrice: Number(price), ingredients: lines.map((line) => ({ ...line, quantity: Number(line.quantity) })) }); }
  let preview: ReturnType<typeof productCost> | null = null;
  try { if (price.trim()) preview = productCost(input(), catalog.items, catalog.bases); } catch { /* Incomplete input has no preview. */ }
  function update(key: number, change: Partial<DraftLine>) { setLines((previous) => previous.map((row) => row.key === key ? { ...row, ...change } : row)); }
  async function createCategory() {
    setError(null); setCategoryBusy(true);
    try { const category = await onCategory(parseCategoryName(categoryName)); setCategoryId(category.id); setAddingCategory(false); setCategoryName(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not create category"); }
    finally { setCategoryBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try { if (addingCategory) throw new Error("Create the category first, or cancel category entry."); const value = input(); productCost(value, catalog.items, catalog.bases); await onSave(value); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not save product"); }
  }
  return <form className={`engineering-editor ${styles.editor}`} onSubmit={(event) => void submit(event)} aria-label={existing ? `Edit ${existing.name}` : "Create product"}><fieldset disabled={busy || categoryBusy}>
    <div className="engineering-section-heading"><div><p className="eyebrow">{existing ? "Edit product" : "New product"}</p><h2>{existing ? existing.name : "Add a product"}</h2></div><button className="engineering-secondary" type="button" onClick={onCancel}>Cancel</button></div>
    <div className={styles.formGrid}>
      <label><span>Product name *</span><input autoFocus required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Carbonara Pasta" /></label>
      <label><span>Product ID (optional)</span><input maxLength={80} readOnly={Boolean(existing)} value={id} onChange={(event) => setId(event.target.value)} placeholder="e.g. MENU-001" /><small>{existing ? "ID stays fixed after creation." : "Leave blank to generate an ID. Letters, numbers, dots, hyphens, or underscores."}</small></label>
      <label><span>Product type *</span><select value={type} onChange={(event) => { setType(event.target.value as ProductType); setParent(""); }}>{PRODUCT_TYPES.map((value) => <option key={value} value={value}>{PRODUCT_LABELS[value]}</option>)}</select><small>Menus, variants and add-ons are all sold products.</small></label>
      <label><span>Category (optional)</span><select value={addingCategory ? "__new" : categoryId} onChange={(event) => { if (event.target.value === "__new") { setAddingCategory(true); setCategoryName(""); } else { setCategoryId(event.target.value); setAddingCategory(false); } }}><option value="">No category</option>{catalog.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}<option value="__new">+ Create category</option></select><small>Shared across all stores and product types.</small></label>
      {addingCategory && <div className={productStyles.categoryCreate}><label><span>New category name *</span><input maxLength={200} value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createCategory(); } }} placeholder="e.g. Pasta" /></label><button className="engineering-primary" type="button" onClick={() => void createCategory()}>{categoryBusy ? "Creating…" : "Create category"}</button><button className="engineering-secondary" type="button" onClick={() => setAddingCategory(false)}>Cancel category</button></div>}
      {type === "variant" && <label><span>Main menu product *</span><select required value={parent} onChange={(event) => setParent(event.target.value)}><option value="">Choose a main menu product</option>{parents.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.id}</option>)}</select><small>{parents.length ? "This variant has its own complete recipe and selling price." : "Create a main menu product first, then add its variant."}</small></label>}
      <label><span>Selling price (IDR) *</span><input required type="number" min="0" max="1000000000000" step="any" value={price} onChange={(event) => setPrice(event.target.value)} /><small>Price per sold unit for costing. Actual transaction prices come from the POS.</small></label>
    </div>
    <section className={recipeStyles.ingredients} aria-label="Recipe ingredients"><h3>Ingredients *</h3><p className={recipeStyles.hint}>Quantities are for one sold unit. Choose raw materials, bases, or both. At least one is required.</p>
      {!options.length && <p className="notice">Add a raw material in <Link href="/items?create=1">Items</Link> or create a <Link href="/bases?create=1">Base</Link> first.</p>}
      {lines.map((row, index) => {
        const units = productIngredientUnits(row, catalog.items, catalog.bases);
        let lineCost: number | null = null;
        try { if (row.ingredientId && Number(row.quantity) > 0) lineCost = productCost({ ingredients: [{ ...row, quantity: Number(row.quantity) }], salesPrice: 0 }, catalog.items, catalog.bases).totalProductionCost; } catch { /* Incomplete lines have no cost. */ }
        return <div className={recipeStyles.row} key={row.key}>
          <div className={`${recipeStyles.field} ${recipeStyles.ingredient}`}><span>Ingredient {index + 1} *</span><ProductIngredientPicker label={`Ingredient ${index + 1}`} value={row.ingredientId ? `${row.kind}:${row.ingredientId}` : ""} options={options} onChange={(value) => {
            if (!value) { update(row.key, { ingredientId: "" }); return; }
            const separator = value.indexOf(":"); const kind = value.slice(0, separator) as ProductIngredient["kind"]; const ingredientId = value.slice(separator + 1);
            const unit = kind === "item" ? catalog.items.find((item) => item.id === ingredientId)?.baseUom : catalog.bases.find((base) => base.id === ingredientId)?.baseUom;
            update(row.key, { kind, ingredientId, uom: unit || "g" });
          }} /></div>
          <label className={recipeStyles.field}><span>Quantity *</span><input aria-label={`Quantity for ingredient ${index + 1}`} required type="number" min="0.000000001" max="1000000000000" step="any" value={row.quantity} onChange={(event) => update(row.key, { quantity: event.target.value })} /></label>
          <label className={recipeStyles.field}><span>Unit *</span><select aria-label={`Unit for ingredient ${index + 1}`} value={row.uom} onChange={(event) => update(row.key, { uom: event.target.value })}>{(units.length ? units : [row.uom]).map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
          <div className={recipeStyles.lineCost}><span>Cost</span><strong>{lineCost === null ? "—" : money.format(lineCost)}</strong></div>
          <button className={`engineering-remove ${recipeStyles.remove}`} type="button" disabled={lines.length === 1} aria-label={`Remove ingredient ${index + 1}`} onClick={() => setLines(lines.filter((line) => line.key !== row.key))}>×</button>
        </div>;
      })}
      <button className="engineering-secondary" type="button" disabled={lines.length >= 200 || !options.length} onClick={() => { setLines([...lines, { key: nextKey, kind: "item", ingredientId: "", quantity: "", uom: "g" }]); setNextKey(nextKey + 1); }}>+ Add ingredient</button>
    </section>
    <div className={styles.costPreview} aria-live="polite"><div><span>Total production cost</span><strong>{preview ? money.format(preview.totalProductionCost) : "—"}</strong></div><div><span>Cost percentage</span><strong>{preview?.costPercentage != null ? `${percent.format(preview.costPercentage)}%` : "—"}</strong></div><div><span>Margin (IDR)</span><strong className={preview && preview.margin < 0 ? "engineering-invalid" : undefined}>{preview ? money.format(preview.margin) : "—"}</strong></div><div><span>Margin percentage</span><strong>{preview?.marginPercentage != null ? `${percent.format(preview.marginPercentage)}%` : "—"}</strong></div></div>
    <p className={recipeStyles.hint}>Base costs already include their 5% production allowance. Product costs are the sum of ingredients. Percentages are unavailable for a zero selling price.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="engineering-form-actions"><span>* Required fields. The product and its recipe save together.</span><button className="engineering-primary" type="submit" disabled={busy || addingCategory || !options.length || (type === "variant" && !parents.length)}>{busy ? "Saving…" : existing ? "Save changes" : "Create product"}</button></div>
  </fieldset></form>;
}
async function responseError(response: Response, fallback: string) {
  if (response.status === 401) window.location.assign("/login?next=/products");
  const body = await response.json().catch(() => null); return typeof body?.error === "string" ? body.error : fallback;
}
export function Products({ initialCatalog, initialError, startCreating = false }: { initialCatalog: ProductCatalog; initialError: string | null; startCreating?: boolean }) {
  const [catalog, setCatalog] = useState(initialCatalog); const [search, setSearch] = useState(""); const [filter, setFilter] = useState<ProductType | "all">("all");
  const [editor, setEditor] = useState<Product | "new" | null>(startCreating && !initialError ? "new" : null); const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [mutating, setMutating] = useState(false); const [available, setAvailable] = useState(!initialError);
  const [error, setError] = useState(initialError); const [message, setMessage] = useState<string | null>(null);
  const categories = new Map(catalog.categories.map((category) => [category.id, category.name]));
  const visible = catalog.products.filter((product) => (filter === "all" || filter === product.type) && `${product.name} ${product.id} ${categories.get(product.categoryId || "") || ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  async function refresh() {
    setLoading(true); setError(null);
    try { const response = await fetch("/api/products", { cache: "no-store" }); if (!response.ok) throw new Error(await responseError(response, "Could not load products")); setCatalog(await response.json()); setAvailable(true); return true; }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load products"); setAvailable(false); return false; } finally { setLoading(false); }
  }
  async function save(input: ProductInput) {
    setMutating(true); setMessage(null); setError(null);
    try { const existing = editor !== "new" ? editor : null;
      const response = await fetch(existing ? `/api/products/${encodeURIComponent(existing.id)}` : "/api/products", { method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(await responseError(response, "Could not save product"));
      setEditor(null); const refreshed = await refresh(); setMessage(refreshed ? `${input.name} ${existing ? "updated" : "created"}.` : "Product saved. Refresh to see the latest data.");
    } finally { setMutating(false); }
  }
  async function createCategory(name: string): Promise<Category> {
    const response = await fetch("/api/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!response.ok) throw new Error(await responseError(response, "Could not create category"));
    const { category } = await response.json() as { category: Category };
    setCatalog((previous) => ({ ...previous, categories: [...previous.categories.filter((existing) => existing.id !== category.id), category].sort((a, b) => a.name.localeCompare(b.name)) }));
    return category;
  }
  async function remove(product: Product) {
    setMutating(true); setError(null); setMessage(null);
    try { const response = await fetch(`/api/products/${encodeURIComponent(product.id)}`, { method: "DELETE" }); if (!response.ok) throw new Error(await responseError(response, "Could not delete product")); setDeleting(null); const refreshed = await refresh(); setMessage(refreshed ? `${product.name} deleted.` : "Product deleted. Refresh to see the latest data."); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not delete product"); } finally { setMutating(false); }
  }
  const disabled = loading || mutating || editor !== null || !available;
  return <main className={`shell engineering-shell ${styles.shell}`}><header className="subpage-header"><div><p className="eyebrow">Spark Intelligence · Catalog & recipes</p><h1>Products</h1><p className="subtitle">Sold menus, variants and add-ons, shared across all stores.</p></div><nav className="header-actions" aria-label="Account and navigation"><Link className="back-link" href="/items">Items</Link><Link className="back-link" href="/bases">Bases</Link><Link className="back-link" href="/">Dashboard</Link><Link className="back-link" href="/stock-opname">Stock Opname</Link><Link className="back-link" href="/settings">Settings</Link><LogoutButton /></nav></header>
    {error && <div className="error" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}
    <div className="engineering-toolbar"><div className={productStyles.filters}><label><span>Search products</span><input type="search" placeholder="Search by name, ID or category" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label><span>Product type</span><select value={filter} onChange={(event) => setFilter(event.target.value as ProductType | "all")}><option value="all">All types</option>{PRODUCT_TYPES.map((type) => <option key={type} value={type}>{PRODUCT_LABELS[type]}</option>)}</select></label></div><div className="engineering-toolbar-actions"><button className="engineering-secondary" type="button" disabled={loading || mutating || editor !== null} onClick={() => { setMessage(null); void refresh(); }}>{loading ? "Refreshing…" : "Refresh"}</button><button className="engineering-primary" type="button" disabled={disabled} onClick={() => { setEditor("new"); setDeleting(null); setMessage(null); setError(null); }}>Create product</button></div></div>
    {editor !== null && <ProductForm key={editor === "new" ? "new" : editor.id} existing={editor === "new" ? null : editor} catalog={catalog} busy={mutating} onCancel={() => setEditor(null)} onSave={save} onCategory={createCategory} />}
    <section aria-label="Product catalog" aria-busy={loading}><p className={styles.count}>{visible.length === catalog.products.length ? `${catalog.products.length} ${catalog.products.length === 1 ? "product" : "products"}` : `${visible.length} of ${catalog.products.length} products`}</p><div className="engineering-table-wrap"><table className={`engineering-table ${styles.table} ${productStyles.table}`}><thead><tr>{["Product / ID", "Type", "Category", "Selling price", "Production cost", "Cost %", "Margin", "Updated (WITA)", "Actions"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>
      {visible.map((product) => { let cost: ReturnType<typeof productCost> | null = null; try { cost = productCost(product, catalog.items, catalog.bases); } catch { /* Display missing-cost state instead of incorrect numbers. */ }
        const usedBy = catalog.products.some((entry) => entry.parentProductId === product.id);
        return <tr key={product.id}><td><strong>{product.name}</strong><small className={styles.id}>{product.id}</small></td><td>{PRODUCT_LABELS[product.type]}{product.parentProductId && <small>of {catalog.products.find((entry) => entry.id === product.parentProductId)?.name || product.parentProductId}</small>}</td><td>{categories.get(product.categoryId || "") || "—"}</td><td>{money.format(product.salesPrice)}</td><td>{cost ? money.format(cost.totalProductionCost) : "Refresh required"}</td><td>{cost?.costPercentage != null ? `${percent.format(cost.costPercentage)}%` : "—"}</td><td className={cost && cost.margin < 0 ? "engineering-invalid" : undefined}><strong>{cost ? money.format(cost.margin) : "—"}</strong><small>{cost?.marginPercentage != null ? `${percent.format(cost.marginPercentage)}%` : "—"}</small></td><td><time dateTime={product.updatedAt}>{date.format(new Date(product.updatedAt))}</time></td><td><div className="engineering-row-actions"><button className="engineering-secondary" type="button" disabled={disabled} aria-label={`Edit ${product.name}`} onClick={() => { setEditor(product); setDeleting(null); setMessage(null); setError(null); }}>Edit</button><button className="engineering-delete" type="button" disabled={disabled || usedBy} title={usedBy ? "Remove or reassign its variants first" : undefined} aria-label={`Delete ${product.name}`} onClick={() => { setDeleting(product.id); setMessage(null); setError(null); }}>Delete</button></div>
          {usedBy && <small>Used by variants</small>}{deleting === product.id && <div className="engineering-delete-confirm" role="group" aria-label={`Confirm deletion of ${product.name}`}><p>Delete {product.name} and its recipe?</p><button className="engineering-delete" type="button" disabled={mutating} onClick={() => void remove(product)}>{mutating ? "Deleting…" : "Confirm delete"}</button><button className="engineering-secondary" type="button" disabled={mutating} onClick={() => setDeleting(null)}>Cancel</button></div>}
        </td></tr>;
      })}
      {!visible.length && <tr><td colSpan={9} className="engineering-empty">{loading ? "Loading products…" : !available ? "Products are unavailable. Use Refresh to try again." : catalog.products.length ? "No products match your search or filter." : "No products yet. Create your first menu, variant or add-on."}</td></tr>}
    </tbody></table></div></section>
  </main>;
}
