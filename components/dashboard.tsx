"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { hottestItem } from "@/lib/analytics/aggregate";
import type { DailyAnalytics, HourlyItemSale } from "@/lib/analytics/types";

type ItemRow = {
  itemCode: string;
  itemName: string;
  category: string;
  totalQuantity: number;
  totalRevenue: number;
  hours: Map<number, HourlyItemSale>;
};

type Selection = { item: ItemRow; hour: number; sale: HourlyItemSale } | null;

const numberFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const currencyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function buildRows(data: DailyAnalytics): ItemRow[] {
  const byItem = new Map<string, ItemRow>();
  for (const sale of data.hourlyItems) {
    let row = byItem.get(sale.itemCode);
    if (!row) {
      row = {
        itemCode: sale.itemCode,
        itemName: sale.itemName,
        category: sale.category,
        totalQuantity: 0,
        totalRevenue: 0,
        hours: new Map(),
      };
      byItem.set(sale.itemCode, row);
    }
    row.totalQuantity += sale.quantity;
    row.totalRevenue += sale.revenue;
    row.hours.set(sale.hour, sale);
  }
  return [...byItem.values()]
    .sort((a, b) => b.totalQuantity - a.totalQuantity || b.totalRevenue - a.totalRevenue)
    .slice(0, 15);
}

export function Dashboard({ initialData }: { initialData: DailyAnalytics }) {
  const [data, setData] = useState(initialData);
  const [date, setDate] = useState(initialData.date);
  const [selection, setSelection] = useState<Selection>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(data), [data]);
  const hottest = useMemo(() => hottestItem(data.hourlyItems), [data.hourlyItems]);
  const maxCell = Math.max(1, ...data.hourlyItems.map((entry) => entry.quantity));
  const hours = Array.from({ length: 24 }, (_, index) => index);

  async function load(nextDate = date, quiet = false) {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/analytics?date=${encodeURIComponent(nextDate)}`, {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not refresh analytics");
      setData(payload as DailyAnalytics);
      setSelection(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not refresh analytics");
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(
      () => void load(date, true),
      Math.max(3, data.refreshSeconds) * 1000,
    );
    return () => window.clearInterval(timer);
    // Recreate the timer only when the selected date or configured interval changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, data.refreshSeconds]);

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Kaspin · POS intelligence</p>
          <h1>Daily item pulse</h1>
          <p className="subtitle">See what sells, and when demand peaks throughout the day.</p>
        </div>
        <div className="date-controls">
          <label htmlFor="business-date">Business date</label>
          <div className="control-row">
            <input
              id="business-date"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                void load(event.target.value);
              }}
            />
            <button type="button" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh view"}
            </button>
          </div>
        </div>
      </header>

      {data.source === "demo" && (
        <div className="notice" role="status">
          Previewing the supplied API sample. Connect Supabase and run a sync to show live POS data.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      <section className="metrics" aria-label="Daily totals">
        <article className="metric metric-accent">
          <span>Gross sales</span>
          <strong>{currencyFormatter.format(data.totalRevenue)}</strong>
          <small>{data.date}</small>
        </article>
        <article className="metric">
          <span>Items sold</span>
          <strong>{numberFormatter.format(data.totalUnits)}</strong>
          <small>Net of returned quantities</small>
        </article>
        <article className="metric">
          <span>Transactions</span>
          <strong>{numberFormatter.format(data.transactionCount)}</strong>
          <small>Receipts recorded</small>
        </article>
        <article className="metric">
          <span>Top item</span>
          <strong className="metric-name">{hottest?.itemName || "No sales yet"}</strong>
          <small>{hottest ? `${numberFormatter.format(hottest.quantity)} units` : "—"}</small>
        </article>
      </section>

      <section className="heatmap-section" aria-labelledby="heatmap-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Demand by hour</p>
            <h2 id="heatmap-title">Item activity heatmap</h2>
          </div>
          <p className="sync-copy">
            {data.lastSyncedAt
              ? `Last synced ${new Date(data.lastSyncedAt).toLocaleString()}`
              : `View refreshes every ${Math.round(data.refreshSeconds / 60)} min`}
          </p>
        </div>

        {rows.length ? (
          <>
            <div className="heatmap-scroll">
              <div className="heatmap" role="grid" aria-label={`Item sales by hour for ${data.date}`}>
                <div className="corner" role="columnheader">Top items</div>
                {hours.map((hour) => (
                  <div className="hour-label" role="columnheader" key={hour}>
                    {String(hour).padStart(2, "0")}
                  </div>
                ))}

                {rows.map((item) => (
                  <div className="heatmap-row" role="row" key={item.itemCode}>
                    <div className="item-label" role="rowheader">
                      <span>{item.itemName}</span>
                      <small>{numberFormatter.format(item.totalQuantity)} units</small>
                    </div>
                    {hours.map((hour) => {
                      const sale = item.hours.get(hour);
                      const quantity = sale?.quantity || 0;
                      const intensity = quantity ? 0.16 + 0.84 * Math.sqrt(quantity / maxCell) : 0;
                      const label = sale
                        ? `${item.itemName}, ${String(hour).padStart(2, "0")}:00: ${numberFormatter.format(quantity)} units, ${currencyFormatter.format(sale.revenue)}`
                        : `${item.itemName}, ${String(hour).padStart(2, "0")}:00: no sales`;
                      return (
                        <button
                          type="button"
                          role="gridcell"
                          className={`heat-cell ${sale ? "has-sales" : ""}`}
                          style={{ "--heat": intensity } as CSSProperties}
                          aria-label={label}
                          title={label}
                          key={hour}
                          onClick={() => sale && setSelection({ item, hour, sale })}
                          disabled={!sale}
                        >
                          {sale && quantity >= maxCell * 0.7 ? numberFormatter.format(quantity) : <span className="sr-only">{label}</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="legend" aria-label="Heatmap scale">
              <span>Fewer units</span>
              {[0.16, 0.35, 0.55, 0.76, 1].map((value) => (
                <span className="legend-cell" style={{ "--heat": value } as CSSProperties} key={value} />
              ))}
              <span>More units</span>
            </div>
          </>
        ) : (
          <div className="empty-state">No item transactions were recorded for this date.</div>
        )}

        <div className="selection" aria-live="polite">
          {selection ? (
            <>
              <div>
                <span className="selection-time">{String(selection.hour).padStart(2, "0")}:00–{String((selection.hour + 1) % 24).padStart(2, "0")}:00</span>
                <strong>{selection.item.itemName}</strong>
              </div>
              <div>
                <span>Units</span>
                <strong>{numberFormatter.format(selection.sale.quantity)}</strong>
              </div>
              <div>
                <span>Sales</span>
                <strong>{currencyFormatter.format(selection.sale.revenue)}</strong>
              </div>
            </>
          ) : (
            <p>Select a colored cell to inspect that item and hour.</p>
          )}
        </div>
      </section>
    </main>
  );
}
