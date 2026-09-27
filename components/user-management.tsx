"use client";

import { useState, type FormEvent } from "react";
import type { ManagedUser } from "@/lib/users";

type UserFormState = {
  username: string;
  password: string;
  role: "admin";
  active: boolean;
};

const emptyUser: UserFormState = {
  username: "",
  password: "",
  role: "admin",
  active: true,
};

function UserForm({
  user,
  onSaved,
}: {
  user?: ManagedUser;
  onSaved(users: ManagedUser[]): void;
}) {
  const [form, setForm] = useState<UserFormState>({
    username: user?.username || "",
    password: "",
    role: "admin",
    active: user?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(user ? `/api/users/${user.id}` : "/api/users", {
        method: user ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save user");
      onSaved(payload.users as ManagedUser[]);
      setForm((current) => user ? { ...current, password: "" } : emptyUser);
      setMessage(user ? "User updated." : "User added.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save user");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="user-form" onSubmit={submit}>
      <div className="user-form-main">
        <label>
          <span>Username</span>
          <input
            required
            minLength={3}
            autoComplete="off"
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
            placeholder="branch.admin"
          />
        </label>
        <label>
          <span>{user ? "New password (optional)" : "Password"}</span>
          <input
            required={!user}
            minLength={8}
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            placeholder={user ? "Leave blank to keep current" : "At least 8 characters"}
          />
        </label>
        <label>
          <span>Role</span>
          <select value="admin" disabled aria-label="Role">
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <div className="user-form-actions">
        <label className="active-toggle">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) => setForm({ ...form, active: event.target.checked })}
          />
          <span>Active account</span>
        </label>
        {message && <p className="form-message" role="status">{message}</p>}
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : user ? "Save user" : "Add user"}
        </button>
      </div>
    </form>
  );
}

export function UserManagement({ initialUsers }: { initialUsers: ManagedUser[] }) {
  const [users, setUsers] = useState(initialUsers);
  return (
    <section className="user-management" aria-labelledby="users-title">
      <div className="settings-section-heading">
        <div>
          <p className="eyebrow">Access control</p>
          <h2 id="users-title">User management</h2>
        </div>
        <p>Admins can view the dashboard and manage stores and users.</p>
      </div>
      <div className="settings-stack">
        {users.map((user) => (
          <UserForm user={user} onSaved={setUsers} key={user.id} />
        ))}
        <UserForm onSaved={setUsers} />
      </div>
    </section>
  );
}
