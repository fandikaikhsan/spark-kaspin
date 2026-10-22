"use client";
import { useId, useState, type KeyboardEvent } from "react";
import type { ReceivingItem } from "@/lib/receiving/model";

export function ReceivingItemPicker({ label, value, items, onChange }: { label: string; value: string; items: ReceivingItem[]; onChange(id: string): void }) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = items.find((item) => item.id === value);
  const filtered = items.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes((query || "").trim().toLowerCase())).slice(0, 50);
  function choose(item: ReceivingItem) { onChange(item.id); setQuery(null); setOpen(false); }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setOpen(true);
      setActive((previous) => Math.max(0, Math.min(filtered.length - 1, previous + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && open) { event.preventDefault(); if (filtered[active]) choose(filtered[active]); }
    else if (event.key === "Escape") { setOpen(false); setQuery(null); }
  }
  return <div className="engineering-combo" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(null); } }}>
    <label className="sr-only" htmlFor={id}>{label}</label>
    <input id={id} role="combobox" required autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-options` : undefined}
      aria-activedescendant={open && filtered[active] ? `${id}-option-${active}` : undefined}
      value={query ?? (selected ? `${selected.name} · ${selected.id}` : "")} placeholder="Cari nama / ID barang…"
      onFocus={() => { setOpen(true); setActive(0); }} onKeyDown={keyDown}
      onChange={(event) => { setQuery(event.target.value); onChange(""); setOpen(true); setActive(0); }} />
    {open && <ul className="engineering-options" role="listbox" id={`${id}-options`} aria-label={label}>
      {filtered.map((item, index) => <li id={`${id}-option-${index}`} key={item.id} role="option" aria-selected={value === item.id}
        className={active === index ? "is-active" : ""} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
        <strong>{item.name}</strong><small>{item.id} · {item.purchaseUnitName}</small>
      </li>)}
      {!filtered.length && <li role="presentation">Barang tidak ditemukan. Barang harus terdaftar di Items.</li>}
    </ul>}
  </div>;
}
