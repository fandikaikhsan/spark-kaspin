"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogoutButton } from "@/components/logout-button";
import type { TransactionPage } from "@/lib/analytics/types";

const currencyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function orderedAt(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export function TransactionsTable({ initialData }: { initialData: TransactionPage }) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [date, setDate] = useState(initialData.date);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextPage: number, nextStoreId = data.store.id, nextDate = date) {
    setLoading(true);
    setError(null);
    const parameters = new URLSearchParams({
      store: nextStoreId,
      date: nextDate,
      page: String(nextPage),
      pageSize: String(data.pageSize),
    });
    try {
      const response = await fetch(`/api/transactions?${parameters.toString()}`, { cache: "no-store" });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load transactions");
      setData(payload as TransactionPage);
      setDate(nextDate);
      router.replace(`/transactions?${parameters.toString()}`, { scroll: false });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load transactions");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell transactions-shell">
      <header className="subpage-header">
        <div>
          <p className="eyebrow">Spark Intelligence</p>
          <h1>Transactions</h1>
          <p className="subtitle">Every receipt recorded for the selected business day.</p>
        </div>
        <nav className="header-actions" aria-label="Account and navigation">
          <Link className="back-link" href="/">Back to dashboard</Link>
          <LogoutButton />
        </nav>
      </header>

      <section className="transaction-filters" aria-label="Transaction filters">
        <label>
          <span>Store</span>
          <select
            value={data.store.id}
            onChange={(event) => {
              const store = data.stores.find((candidate) => candidate.id === event.target.value);
              if (!store) return;
              setDate(store.businessDate);
              void load(1, store.id, store.businessDate);
            }}
          >
            {data.stores.map((store) => (
              <option value={store.id} key={store.id}>{store.name} ({store.utcOffset})</option>
            ))}
          </select>
        </label>
        <label>
          <span>Business date</span>
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              void load(1, data.store.id, event.target.value);
            }}
          />
        </label>
        <p>{data.totalCount.toLocaleString("id-ID")} receipts</p>
      </section>

      {error && <div className="error" role="alert">{error}</div>}

      <div className={`transaction-table-wrap ${loading ? "is-loading" : ""}`}>
        <table className="transaction-table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Ordered</th>
              <th>Items</th>
              <th>Payment</th>
              <th className="amount-cell">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.transactions.map((transaction) => (
              <tr key={transaction.transactionCode}>
                <td>
                  <strong>#{transaction.receiptNumber}</strong>
                  <small>{transaction.transactionCode}</small>
                </td>
                <td>{orderedAt(transaction.occurredAt, data.store.timeZone)}</td>
                <td>
                  <ul className="table-items">
                    {transaction.items.map((item) => (
                      <li key={item.lineNumber}>
                        <span>{item.itemName}</span>
                        <strong>× {item.quantity.toLocaleString("id-ID")}</strong>
                      </li>
                    ))}
                  </ul>
                </td>
                <td><span className="payment-pill">{transaction.paymentType}</span></td>
                <td className="amount-cell"><strong>{currencyFormatter.format(transaction.grandTotal)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.transactions.length && <div className="empty-state">No transactions were recorded for this date.</div>}
      </div>

      <nav className="pagination" aria-label="Transaction pages">
        <button
          type="button"
          disabled={loading || data.page <= 1}
          onClick={() => void load(data.page - 1)}
        >
          Previous
        </button>
        <span>Page {data.page} of {data.totalPages}</span>
        <button
          type="button"
          disabled={loading || data.page >= data.totalPages}
          onClick={() => void load(data.page + 1)}
        >
          Next
        </button>
      </nav>
    </main>
  );
}
