"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { UserManagement } from "@/components/user-management";
import type { StoreAdminSummary } from "@/lib/store-settings";
import type { ManagedUser } from "@/lib/users";

type StoreFormState = {
  name: string;
  timeZone: "Asia/Jakarta" | "Asia/Makassar";
  active: boolean;
  accessToken: string;
  refreshToken: string;
};

const emptyStore: StoreFormState = {
  name: "",
  timeZone: "Asia/Jakarta",
  active: true,
  accessToken: "",
  refreshToken: "",
};

function StoreForm({
  store,
  onSaved,
}: {
  store?: StoreAdminSummary;
  onSaved(stores: StoreAdminSummary[]): void;
}) {
  const [form, setForm] = useState<StoreFormState>({
    name: store?.name || "",
    timeZone: store?.timeZone || "Asia/Jakarta",
    active: store?.active ?? true,
    accessToken: "",
    refreshToken: "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(store ? `/api/stores/${store.id}` : "/api/stores", {
        method: store ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save store");
      onSaved(payload.stores as StoreAdminSummary[]);
      setForm((current) => store
        ? { ...current, accessToken: "", refreshToken: "" }
        : emptyStore);
      setMessage(store ? "Store updated." : "Store added.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save store");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="store-form" onSubmit={submit}>
      <div className="store-form-heading">
        <div>
          <p className="eyebrow">{store ? "Branch configuration" : "New branch"}</p>
          <h2>{store?.name || "Add a store"}</h2>
        </div>
        {store && (
          <span className={`credential-state ${store.hasRefreshToken ? "ready" : "missing"}`}>
            {store.hasRefreshToken ? "Refresh token saved" : "Refresh token missing"}
          </span>
        )}
      </div>

      <div className="settings-grid">
        <label>
          <span>Store name</span>
          <input
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Sarkop Tanjung Satu"
          />
        </label>
        <label>
          <span>Timezone</span>
          <select
            value={form.timeZone}
            onChange={(event) => setForm({
              ...form,
              timeZone: event.target.value as StoreFormState["timeZone"],
            })}
          >
            <option value="Asia/Jakarta">UTC+7 · Asia/Jakarta</option>
            <option value="Asia/Makassar">UTC+8 · Asia/Makassar</option>
          </select>
        </label>
        <label>
          <span>Initial access token {store && "(leave blank to keep current)"}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={form.accessToken}
            onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
            placeholder={store?.hasAccessToken ? "Stored securely" : "Optional if already expired"}
          />
        </label>
        <label>
          <span>Refresh token {store && "(leave blank to keep current)"}</span>
          <input
            required={!store}
            type="password"
            autoComplete="new-password"
            value={form.refreshToken}
            onChange={(event) => setForm({ ...form, refreshToken: event.target.value })}
            placeholder={store?.hasRefreshToken ? "Stored securely" : "Required for automatic renewal"}
          />
        </label>
      </div>

      <div className="store-form-actions">
        <label className="active-toggle">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) => setForm({ ...form, active: event.target.checked })}
          />
          <span>Poll this store</span>
        </label>
        {message && <p className="form-message" role="status">{message}</p>}
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : store ? "Save changes" : "Add store"}
        </button>
      </div>
      {store?.credentialsUpdatedAt && (
        <p className="credential-updated">
          Credentials last updated {new Date(store.credentialsUpdatedAt).toLocaleString()}.
        </p>
      )}
    </form>
  );
}

export function StoreSettings({
  initialStores,
  initialUsers,
}: {
  initialStores: StoreAdminSummary[];
  initialUsers: ManagedUser[];
}) {
  const [stores, setStores] = useState(initialStores);
  return (
    <main className="shell settings-shell">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Spark Intelligence · Administration</p>
          <h1>Store settings</h1>
          <p className="subtitle">
            Configure branch timezones and seed credentials. Token values are never displayed again.
          </p>
        </div>
        <nav className="header-actions" aria-label="Account and navigation">
          <Link className="back-link" href="/">Back to dashboard</Link>
          <LogoutButton />
        </nav>
      </header>

      <div className="settings-stack">
        {stores.map((store) => (
          <StoreForm store={store} onSaved={setStores} key={store.id} />
        ))}
        <StoreForm onSaved={setStores} />
      </div>
      <UserManagement initialUsers={initialUsers} />
    </main>
  );
}
