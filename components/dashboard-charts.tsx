"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TransactionReceipt } from "@/lib/analytics/types";
import type { ProductSales } from "@/lib/analytics/dashboard";
import styles from "./dashboard.module.css";

export const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const money = (value: number) => currency.format(value);
export const shortMoney = (value: number) => value >= 1_000_000 ? `Rp${number.format(value / 1_000_000)} jt` : value >= 1000 ? `Rp${number.format(value / 1000)} rb` : money(value);
export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
export const hours = Array.from({ length: 24 }, (_, index) => index);
export const dateLabel = (date: string, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", options || { day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`));

type IconName = "chart" | "boxes" | "cart" | "book" | "settings" | "logout" | "pin" | "refresh" | "package" | "receipt" | "wallet";
export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    chart: <path d="M4 4v16h16M7 14l4-5 4 3 5-7" />,
    boxes: <path d="m12 2 5 3-5 3-5-3 5-3ZM7 12l5 3-5 3-5-3 5-3Zm10 0 5 3-5 3-5-3 5-3ZM7 5v5m10-5v5M2 15v5l5 3 5-3v-5m0 0v5l5 3 5-3v-5M7 18v5m10-5v5" />,
    cart: <><path d="M3 4h2l2.5 11H19l2-8H6" /><circle cx="9" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></>,
    book: <path d="M12 6v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z" />,
    settings: <><path d="m10 3-1 3-3 1-3-1-1 4 3 2 1 3-1 3 4 2 2-3h3l2 3 4-2-1-3 1-3 3-2-1-4-3 1-3-1-1-3h-5Z" /><circle cx="12" cy="11" r="3" /></>,
    logout: <path d="M10 4H4v16h6m4-12 4 4-4 4m-5-4h12" />,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
    refresh: <path d="M20 8V3l-3 3a8 8 0 1 0 2 10M20 3h-5" />,
    package: <path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10M7 5l9 5" />,
    receipt: <path d="m5 3 2 2 2-2 3 2 3-2 2 2 2-2v18l-2-2-2 2-3-2-3 2-2-2-2 2V3Zm4 5h6m-6 4h6m-6 4h4" />,
    wallet: <><path d="M20 7H4V4h14v3M4 7v13h16V7m0 4h-6v5h6" /><circle cx="17" cy="13.5" r=".5" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Delta({ value, label }: { value: number | null; label: string }) {
  return <div className={styles.delta}><span className={styles.deltaValue}>
    {value !== null && value !== 0 && <i className={value > 0 ? styles.up : styles.down} aria-hidden="true" />}
    {value === null ? "—" : `${number.format(Math.abs(value))}%`}
    <span className="sr-only">{value === null ? "Comparison unavailable" : value > 0 ? " increase" : value < 0 ? " decrease" : " change"}</span>
  </span><span>{value === null ? "No prior-period data" : label}</span></div>;
}

export function SalesChart({ values, labels, amount = true, lineAverage, partialIndex, futureAfter, compact = false, quantityLabel = "units" }: {
  values: number[]; labels: string[]; amount?: boolean; lineAverage?: (number | null)[];
  partialIndex?: number; futureAfter?: number; compact?: boolean; quantityLabel?: string;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(500);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = compact ? 156 : 186;
  const left = amount ? 58 : 36, right = 12, top = 16, bottom = 27;
  const pw = width - left - right, ph = height - top - bottom;
  const max = Math.max(1, ...values, ...(lineAverage || []).filter((value): value is number => value !== null));
  const power = 10 ** Math.floor(Math.log10(max));
  const ceiling = Math.ceil(max / power / 2) * power * 2;
  const x = (index: number) => left + (index + .5) * pw / Math.max(1, values.length);
  const y = (value: number) => top + ph - (value / ceiling) * ph;
  const last = futureAfter === undefined ? values.length - 1 : Math.min(futureAfter, values.length - 1);
  const path = values.slice(0, last + 1).map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join(" ");
  const averagePath = (lineAverage || []).map((value, index, all) => value === null ? "" : `${index === 0 || all[index - 1] === null ? "M" : "L"}${x(index)},${y(value)}`).join(" ");
  const ticks = width < 400 ? [0, Math.floor((values.length - 1) / 2), values.length - 1] : [0, Math.floor((values.length - 1) / 3), Math.floor((values.length - 1) * 2 / 3), values.length - 1];
  const gradientId = `sales-${amount ? "money" : "units"}-${compact ? "compact" : "main"}`;
  const hovering = hover !== null && hover < values.length ? hover : null;
  return <div ref={holder} className={styles.chart}>
    {hovering !== null && <div className={styles.chartTooltip} role="status"><b>{labels[hovering]}</b><span>{futureAfter !== undefined && hovering > futureAfter ? "Not yet occurred" : amount ? money(values[hovering]) : `${number.format(values[hovering])} ${quantityLabel}`}{partialIndex === hovering ? " · partial" : ""}</span></div>}
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${amount ? "Gross sales" : quantityLabel} by ${labels[0]?.includes(":") ? "hour" : "day"}${partialIndex !== undefined ? "; current interval is partial" : ""}`} onMouseLeave={() => setHover(null)}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b64b20" stopOpacity=".23" /><stop offset="100%" stopColor="#b64b20" stopOpacity=".015" /></linearGradient></defs>
      {[0, .5, 1].map((fraction) => <g key={fraction}><line x1={left} x2={width - right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} className={styles.chartGrid} /><text x={left - 8} y={y(ceiling * fraction) + 4} textAnchor="end">{amount ? shortMoney(ceiling * fraction) : number.format(ceiling * fraction)}</text></g>)}
      {futureAfter !== undefined && futureAfter < values.length - 1 && <rect x={x(futureAfter + 1) - pw / values.length / 2} y={top} width={(values.length - futureAfter - 1) * pw / values.length} height={ph} fill="#ede6df" opacity=".5" />}
      {values.length > 0 && <><path d={`${path} L${x(last)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${gradientId})`} /><path d={path} className={styles.salesLine} />
        {averagePath && <path d={averagePath} className={styles.averageLine} />}
        {partialIndex !== undefined && partialIndex <= last && <><line x1={x(partialIndex)} x2={x(partialIndex)} y1={top} y2={y(0)} className={styles.partialLine} /><circle cx={x(partialIndex)} cy={y(values[partialIndex])} r="3.5" fill="#b64b20" /></>}
      </>}
      {[...new Set(ticks)].filter((index) => index >= 0).map((index) => <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === values.length - 1 ? "end" : "middle"}>{labels[index]}</text>)}
      {values.map((value, index) => <rect key={index} x={x(index) - pw / values.length / 2} y={top} width={pw / values.length} height={ph} fill="transparent" onMouseEnter={() => setHover(index)} onClick={() => setHover(hover === index ? null : index)}><title>{`${labels[index]}: ${futureAfter !== undefined && index > futureAfter ? "Not yet occurred" : amount ? money(value) : number.format(value)}${partialIndex === index ? " (partial)" : ""}`}</title></rect>)}
    </svg>
  </div>;
}

export function ProductMix({ products }: { products: ProductSales[] }) {
  const palette = ["#b64b20", "#174f3c", "#e8a77c", "#8eafa0", "#e9e5df"];
  const positive = products.filter((product) => product.revenue > 0);
  const total = sum(positive.map((product) => product.revenue));
  const top = positive.slice(0, 4).map((product) => ({ name: product.name, revenue: product.revenue }));
  const other = total - sum(top.map((product) => product.revenue));
  const slices = other > 0 ? [...top, { name: "Other products", revenue: other }] : top;
  let offset = 0;
  const gradient = slices.map((slice, index) => { const start = offset; offset += slice.revenue / total * 100; return `${palette[index]} ${start}% ${offset}%`; }).join(",");
  return <section className={`${styles.panel} ${styles.mix}`} aria-labelledby="mix-title"><div><h2 id="mix-title">Product sales mix</h2><p className={styles.caption}>{products.some((product) => product.revenue < 0) ? "Share of positive item sales" : "Top 4 products + other · gross sales"}</p></div>
    {total > 0 ? <><div className={styles.pie} style={{ background: `conic-gradient(${gradient})` }} role="img" aria-label={slices.map((slice) => `${slice.name}: ${number.format(slice.revenue / total * 100)}%`).join(", ")} />
      <div className={styles.mixLegend}>{slices.map((slice, index) => <div className={styles.mixRow} key={`${index}-${slice.name}`}><i style={{ background: palette[index] }} aria-hidden="true" /><span>{slice.name}<small>{money(slice.revenue)}</small></span><b>{number.format(slice.revenue / total * 100)}%</b></div>)}</div>
    </> : <div className={styles.empty}>No product sales in this period.</div>}
  </section>;
}

export function ReceiptCard({ transaction, timeZone, isNew }: { transaction: TransactionReceipt; timeZone: string; isNew: boolean }) {
  return <article className={`receipt-card ${isNew ? "is-new" : ""}`}><div className="receipt-pin" aria-hidden="true" />{isNew && <span className="new-receipt-label">New order</span>}
    <div className="receipt-heading"><div><span>Receipt</span><strong>#{transaction.receiptNumber}</strong></div><time dateTime={transaction.occurredAt}>{new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(transaction.occurredAt))}</time></div>
    <div className="receipt-rule" /><ul className="receipt-items">{transaction.items.map((item) => <li key={item.lineNumber}><span><b>{number.format(item.quantity)}×</b> {item.itemName}</span><strong>{money(item.grossSales)}</strong></li>)}</ul>
    <div className="receipt-rule" /><div className="receipt-total"><span>Total</span><strong>{money(transaction.grandTotal)}</strong></div><p className="receipt-payment">{transaction.paymentType}</p>
  </article>;
}
