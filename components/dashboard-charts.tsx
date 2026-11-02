"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { TransactionReceipt } from "@/lib/analytics/types";
import { addDays, BUSINESS_HOURS } from "@/lib/analytics/dashboard";
import type { ProductSales } from "@/lib/analytics/dashboard";
import { ChartTooltip } from "./chart-tooltip";
import styles from "./dashboard.module.css";

export const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const money = (value: number) => currency.format(value);
export const shortMoney = (value: number) => value >= 1_000_000 ? `Rp${number.format(value / 1_000_000)} jt` : value >= 1000 ? `Rp${number.format(value / 1000)} rb` : money(value);
export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
export const hours = BUSINESS_HOURS;
export const dateLabel = (date: string, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", options || { day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`));

type IconName = "chart" | "boxes" | "cart" | "book" | "settings" | "logout" | "pin" | "refresh" | "package" | "receipt" | "wallet" | "plus";
export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    chart: <path d="M4 4v16h16M7 14l4-5 4 3 5-7" />,
    boxes: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9" /><path d="m7.5 5.5 9 5v4l-3 1.7v-4l-9-5" /></>,
    cart: <><path d="M3 4h2l2.5 11H19l2-8H6" /><circle cx="9" cy="20" r="1" /><circle cx="18" cy="20" r="1" /></>,
    book: <path d="M12 6v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z" />,
    settings: <><path d="m9.5 3-.6 2.2-1.5.9-2.2-.6-2.5 4.3 1.6 1.6v1.8l-1.6 1.6 2.5 4.3 2.2-.6 1.5.9.6 2.2h5l.6-2.2 1.5-.9 2.2.6 2.5-4.3-1.6-1.6v-1.8l1.6-1.6-2.5-4.3-2.2.6-1.5-.9-.6-2.2h-5Z" /><circle cx="12" cy="12" r="3" /></>,
    logout: <><path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h10" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
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

export function SalesChart({ values, labels, amount = true, lineAverage, peakValues, peakDates, averageLabel = "7-day average", seriesLabel = "Selected period", tooltipLabels, partialIndex, futureAfter, compact = false, fill = false, quantityLabel = "units" }: {
  values: number[]; labels: string[]; amount?: boolean; lineAverage?: (number | null)[]; peakValues?: (number | null)[]; peakDates?: (string | null)[]; averageLabel?: string; seriesLabel?: string; tooltipLabels?: string[];
  partialIndex?: number; futureAfter?: number; compact?: boolean; fill?: boolean; quantityLabel?: string;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 500, height: 250 });
  const width = size.width;
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(240, Math.floor(entry.contentRect.width)), height: Math.max(180, Math.floor(entry.contentRect.height)) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = compact ? 156 : fill ? size.height : 250;
  const left = amount ? 58 : 36, right = 12, top = 16, bottom = 27;
  const pw = width - left - right, ph = height - top - bottom;
  const max = Math.max(1, ...values, ...(lineAverage || []).filter((value): value is number => value !== null), ...(peakValues || []).filter((value): value is number => value !== null));
  const power = 10 ** Math.floor(Math.log10(max));
  const ceiling = Math.ceil(max / (power / 2)) * (power / 2);
  const x = (index: number) => left + (index + .5) * pw / Math.max(1, values.length);
  const y = (value: number) => top + ph - (value / ceiling) * ph;
  const last = futureAfter === undefined ? values.length - 1 : Math.min(futureAfter, values.length - 1);
  const path = values.slice(0, last + 1).map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join(" ");
  const curve = (points: (number | null)[]) => points.map((value, index, all) => value === null ? "" : `${index === 0 || all[index - 1] === null ? "M" : "L"}${x(index)},${y(value)}`).filter(Boolean).join(" ");
  const averagePath = curve(lineAverage || []), peakPath = curve(peakValues || []);
  const ticks = labels[0]?.includes(":") && width >= 500 ? [0,3,6,9,12,15,18,21,23] : width < 400 ? [0, Math.floor((values.length - 1) / 2), values.length - 1] : [0, Math.floor((values.length - 1) / 3), Math.floor((values.length - 1) * 2 / 3), values.length - 1];
  const gradientId = useId();
  const tooltipId = `${gradientId}-tooltip`;
  const hovering = hover !== null && hover < values.length ? hover : null;
  const formatValue = (value: number) => amount ? money(value) : `${number.format(value)} ${quantityLabel}`;
  const sourceDate = hovering !== null ? peakDates?.[hovering] : null;
  const sourceCalendarDate = sourceDate && hovering !== null && labels[hovering]?.includes(":") && Number(labels[hovering].slice(0, 2)) < 6 ? addDays(sourceDate, 1) : sourceDate;
  return <div ref={holder} className={`${styles.chart} ${fill ? styles.chartFill : ""}`}>
    {hovering !== null && <ChartTooltip id={tooltipId} anchor={holder} point={{ x: x(hovering) / width, y: y(Math.max(futureAfter === undefined || hovering <= futureAfter ? values[hovering] : 0, lineAverage?.[hovering] ?? 0, peakValues?.[hovering] ?? 0)) / height }}>
      <b>{tooltipLabels?.[hovering] || labels[hovering]}{labels[hovering]?.includes(":") ? `–${labels[hovering].slice(0, 2)}:59` : ""}</b>
      <div className={styles.tooltipRow}><span><i style={{ background: "#bf3e1c" }} />{seriesLabel}</span><strong>{futureAfter !== undefined && hovering > futureAfter ? "Not yet occurred" : formatValue(values[hovering])}</strong></div>
      {partialIndex === hovering && <small>Partial interval</small>}
      {lineAverage?.[hovering] != null && <div className={styles.tooltipRow}><span><i style={{ background: "#4b92df" }} />{averageLabel === "Previous 7 days avg." ? "7-day avg." : averageLabel}</span><strong>{formatValue(lineAverage[hovering]!)}</strong></div>}
      {peakValues?.[hovering] != null && <><div className={styles.tooltipRow}><span><i style={{ background: "#dba520" }} />Peak</span><strong>{formatValue(peakValues[hovering]!)}</strong></div>{sourceCalendarDate && <small>Peak recorded: {dateLabel(sourceCalendarDate, { day: "numeric", month: "short", year: "numeric" })}</small>}</>}
    </ChartTooltip>}
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0} aria-describedby={hovering !== null ? tooltipId : undefined} aria-label={`${amount ? "Gross sales" : quantityLabel} by ${labels[0]?.includes(":") ? "hour" : "day"}. Hover or use arrow keys for details${partialIndex !== undefined ? "; current interval is partial" : ""}`}
      onPointerMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const point = (event.clientX - rect.left) * width / rect.width; setHover(point >= left && point <= width - right ? Math.min(values.length - 1, Math.floor((point - left) / pw * values.length)) : null); }}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") setHover(null); }} onFocus={() => setHover(0)} onBlur={() => setHover(null)}
      onKeyDown={(event) => { if (event.key === "Escape") setHover(null); else if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setHover((previous) => Math.max(0, Math.min(values.length - 1, (previous ?? 0) + (event.key === "ArrowRight" ? 1 : -1)))); } }}>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b64b20" stopOpacity=".23" /><stop offset="100%" stopColor="#b64b20" stopOpacity=".015" /></linearGradient></defs>
      {[0, .5, 1].map((fraction) => <g key={fraction}><line x1={left} x2={width - right} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} className={styles.chartGrid} /><text x={left - 8} y={y(ceiling * fraction) + 4} textAnchor="end">{amount ? shortMoney(ceiling * fraction) : number.format(ceiling * fraction)}</text></g>)}
      {futureAfter !== undefined && futureAfter < values.length - 1 && <rect x={x(futureAfter + 1) - pw / values.length / 2} y={top} width={(values.length - futureAfter - 1) * pw / values.length} height={ph} fill="#ede6df" opacity=".5" />}
      {values.length > 0 && <><path d={`${path} L${x(last)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${gradientId})`} /><path d={path} className={styles.salesLine} />
        {peakPath && <path d={peakPath} className={styles.peakLine} />}
        {averagePath && <path d={averagePath} className={styles.averageLine} />}
        {partialIndex !== undefined && partialIndex <= last && <><line x1={x(partialIndex)} x2={x(partialIndex)} y1={top} y2={y(0)} className={styles.partialLine} /><circle cx={x(partialIndex)} cy={y(values[partialIndex])} r="3.5" fill="#b64b20" /></>}
      </>}
      {hovering !== null && <g pointerEvents="none"><line x1={x(hovering)} x2={x(hovering)} y1={top} y2={y(0)} className={styles.hoverLine} />{(futureAfter === undefined || hovering <= futureAfter) && <circle cx={x(hovering)} cy={y(values[hovering])} r="4" fill="#bf3e1c" stroke="white" strokeWidth="1.5" />}{lineAverage?.[hovering] != null && <circle cx={x(hovering)} cy={y(lineAverage[hovering]!)} r="3.5" fill="#4b92df" stroke="white" strokeWidth="1.5" />}{peakValues?.[hovering] != null && <circle cx={x(hovering)} cy={y(peakValues[hovering]!)} r="3.5" fill="#dba520" stroke="white" strokeWidth="1.5" />}</g>}
      {[...new Set(ticks)].filter((index) => index >= 0).map((index) => <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? "start" : index === values.length - 1 ? "end" : "middle"}>{labels[index]}</text>)}
      {values.map((_, index) => <rect key={index} x={x(index) - pw / values.length / 2} y={top} width={pw / values.length} height={ph} fill="transparent" pointerEvents="all" onClick={() => setHover(index)} />)}
    </svg>
  </div>;
}

export function ProductMix({ products }: { products: ProductSales[] }) {
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  const pie = useRef<SVGSVGElement>(null);
  const palette = ["#bf3e1c", "#e8ae28", "#174f3c", "#edb498", "#d9dcdf"];
  const positive = products.filter((product) => product.revenue > 0);
  const total = sum(positive.map((product) => product.revenue));
  const top = positive.slice(0, 4).map((product) => ({ name: product.name, revenue: product.revenue, units: product.units }));
  const other = total - sum(top.map((product) => product.revenue));
  const slices = other > 0 ? [...top, { name: "Other products", revenue: other, units: sum(positive.slice(4).map((product) => product.units)) }] : top;
  let offset = 0;
  const segments = slices.map((slice) => {
    const start = offset; offset += slice.revenue / total * Math.PI * 2;
    const point = (angle: number) => `${50 + 48 * Math.sin(angle)},${50 - 48 * Math.cos(angle)}`;
    const path = offset - start >= Math.PI * 2 - 1e-9 ? "M50 2 A48 48 0 1 1 50 98 A48 48 0 1 1 50 2 Z"
      : `M50 50 L${point(start)} A48 48 0 ${offset - start > Math.PI ? 1 : 0} 1 ${point(offset)} Z`;
    return { ...slice, path, middle: (start + offset) / 2 };
  });
  const selected = active !== null ? segments[active] : null;
  const description = (index: number) => `${slices[index].name}: ${money(slices[index].revenue)}, ${number.format(slices[index].revenue / total * 100)}% of sales, ${number.format(slices[index].units)} units`;
  return <section className={`${styles.panel} ${styles.mix}`} aria-labelledby="mix-title"><div><h2 id="mix-title">Product sales mix</h2><p className={styles.caption}>{products.some((product) => product.revenue < 0) ? "Share of positive item sales" : "Top 4 products + other · gross sales"}</p></div>
    {total > 0 ? <><div className={styles.pieContainer} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActive(null); }}>
      <svg ref={pie} className={styles.pie} viewBox="0 0 100 100" role="group" aria-label="Product sales mix. Hover, tap or focus a slice for details.">
        {segments.map((slice, index) => <path key={`${index}-${slice.name}`} d={slice.path} fill={palette[index]} stroke={active === index ? "#30363b" : "white"} strokeWidth={active === index ? 1 : .4} role="button" tabIndex={0} aria-label={description(index)} aria-describedby={active === index ? tooltipId : undefined}
          onPointerEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onClick={() => setActive(index)} onKeyDown={(event) => { if (event.key === "Escape") setActive(null); else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActive(index); } }} />)}
      </svg>
      {selected && <ChartTooltip id={tooltipId} anchor={pie} outside point={{ x: .5 + .48 * Math.sin(selected.middle), y: .5 - .48 * Math.cos(selected.middle) }}><b>{selected.name}</b><div className={styles.tooltipRow}><span>Gross sales</span><strong>{money(selected.revenue)}</strong></div><small>{number.format(selected.revenue / total * 100)}% of sales / {number.format(selected.units)} units sold</small>{active === 4 && <small>{positive.length - 4} other products combined</small>}</ChartTooltip>}
    </div>
      <div className={styles.mixLegend}>{slices.map((slice, index) => <button type="button" className={styles.mixRow} key={`${index}-${slice.name}`} aria-label={description(index)} aria-describedby={active === index ? tooltipId : undefined} onPointerEnter={() => setActive(index)} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActive(null); }} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onClick={() => setActive(index)} onKeyDown={(event) => { if (event.key === "Escape") setActive(null); }}><i style={{ background: palette[index] }} aria-hidden="true" /><span>{slice.name}<small>{money(slice.revenue)}</small></span><b>{number.format(slice.revenue / total * 100)}%</b></button>)}</div>
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
