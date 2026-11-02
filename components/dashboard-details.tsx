"use client";

import { useState, type CSSProperties } from "react";
import type { DashboardReport } from "@/lib/analytics/types";
import { businessHourIndex, trailingAverage, type ProductSales } from "@/lib/analytics/dashboard";
import { SalesChart, dateLabel, hours, money, number, sum } from "./dashboard-charts";
import styles from "./dashboard.module.css";

export function ItemHeatmap({ products, date, today, currentHour, timeZone }: { products: ProductSales[]; date: string; today: string; currentHour: number; timeZone: string }) {
  const [selection, setSelection] = useState<{ code: string; hour: number } | null>(null);
  const selected = selection ? products.find((product) => product.code === selection.code) : null;
  const rows = products.slice(0, 10);
  const max = Math.max(1, ...rows.flatMap((product) => product.hours));
  return <section className={`${styles.panel} ${styles.heatPanel}`} aria-labelledby="activity-title">
    <div className={styles.panelHeading}><div><h2 id="activity-title">Item activity</h2><p className={styles.caption}>Top 10 products by gross sales · cell intensity = units sold</p></div><span className={styles.caption}>{dateLabel(date)} · {timeZone === "Asia/Makassar" ? "WITA" : "WIB"}</span></div>
    {rows.length ? <><div className={styles.heatScroll}><div className={styles.heatGrid}><span className={styles.heatCorner}>Product</span>{hours.map((hour) => <span className={styles.hour} key={hour}>{String(hour).padStart(2, "0")}</span>)}
      {rows.map((product, index) => <div className={styles.heatRow} key={product.code}><div className={styles.productName} title={product.name}><small>{index + 1}</small><span>{product.name}</span></div>
        {hours.map((hour) => {
          const quantity = product.hours[hour], future = date === today && businessHourIndex(hour) > businessHourIndex(currentHour), current = date === today && hour === currentHour;
          const label = `${product.name}, ${String(hour).padStart(2, "0")}:00: ${future ? "not yet occurred" : `${number.format(quantity)} units${current ? ", partial hour" : ""}`}`;
          return <button type="button" key={hour} aria-label={label} title={label} disabled={future || quantity === 0} className={`${styles.heatCell} ${future ? styles.future : ""} ${current ? styles.current : ""}`} style={{ "--cell-opacity": quantity ? .18 + .82 * Math.sqrt(quantity / max) : 0 } as CSSProperties} onClick={() => setSelection({ code: product.code, hour })}>{quantity > 0 && quantity >= max * .7 && !future ? number.format(quantity) : ""}</button>;
        })}</div>)}
    </div></div><div className={styles.heatFooter}><span>{date === today ? "Outlined: current hour · Hatched: future hours" : "Select a cell for its quantity"}</span><div className={styles.heatLegend}>Less {[.18, .38, .58, .8, 1].map((value) => <i key={value} style={{ opacity: value }} />)} More</div></div>
      {selection && selected && <div className={styles.cellDetail} role="status"><span>{selected.name}</span><span>{String(selection.hour).padStart(2, "0")}:00</span><b>{number.format(selected.hours[selection.hour])} units</b><button type="button" onClick={() => setSelection(null)} aria-label="Close cell detail">×</button></div>}
    </> : <div className={styles.empty}>No item sales recorded for this date.</div>}
  </section>;
}

export function ReportDetails({ report, products }: { report: DashboardReport; products: ProductSales[] }) {
  const monthly = report.mode === "monthly";
  const volume = monthly ? report.daily.map((day) => day.transactions) : hours.map((hour) => sum(report.hourlyItems.filter((item) => item.hour === hour).map((item) => item.quantity)));
  const labels = monthly ? report.daily.map((day) => String(Number(day.date.slice(8)))) : hours.map((hour) => `${String(hour).padStart(2, "0")}:00`);
  const peak = volume.indexOf(Math.max(...volume));
  const basketCount = sum(report.baskets.map((basket) => basket.count));
  const totalUnits = sum(report.daily.map((day) => day.units)), totalOrders = sum(report.daily.map((day) => day.transactions));
  const revenue = sum(products.map((product) => product.revenue));
  const heatMax = Math.max(1, ...report.weekdayHours.flatMap((row) => row.hours));
  return <><div className={styles.detailGrid}>
    <section className={styles.panel}><h2>{monthly ? "Daily transactions" : "Hourly item volume"}</h2><p className={styles.caption}>{monthly ? "Orders and the seven-day trailing average" : "Recorded units · a guide to workload"}</p><div className={styles.volumeStats}><div><b>{monthly ? number.format(totalOrders / Math.max(1, report.daily.length)) : totalUnits ? labels[peak] : "—"}</b><span>{monthly ? "Average orders / day" : "Peak hour"}</span></div><div><b>{monthly ? totalOrders ? number.format(totalUnits / totalOrders) : "—" : number.format(volume[peak] || 0)}</b><span>{monthly ? "Items / transaction" : "Units in peak hour"}</span></div></div><SalesChart values={volume} labels={labels} amount={false} compact lineAverage={monthly ? trailingAverage(volume) : undefined} quantityLabel={monthly ? "orders" : "units"} />{monthly && <div className={styles.chartLegend}><span><i />Orders</span><span><i className={styles.averageSwatch} />7-day average</span></div>}</section>
    <section className={styles.panel}><h2>Basket sizes</h2><p className={styles.caption}>Share of orders with positive net quantities</p><div className={styles.baskets}>{report.baskets.map((basket) => <div className={styles.basket} key={basket.label}><span>{basket.label}</span><div><i style={{ width: `${basketCount ? basket.count / basketCount * 100 : 0}%` }} /></div><b>{basketCount ? `${number.format(basket.count / basketCount * 100)}%` : "—"}</b></div>)}</div>{!basketCount && <p className={styles.caption}>No baskets recorded in this period.</p>}</section>
  </div>
    {monthly && report.weekdayHours.length > 0 && <section className={`${styles.panel} ${styles.heatPanel}`}><div className={styles.panelHeading}><div><h2>When is the store busiest?</h2><p className={styles.caption}>Average transactions for each weekday and hour</p></div><span className={styles.caption}>{dateLabel(report.startDate)}–{dateLabel(report.endDate)}</span></div><div className={styles.heatScroll}><div className={styles.heatGrid}><span className={styles.heatCorner}>Weekday</span>{hours.map((hour) => <span key={hour} className={styles.hour}>{String(hour).padStart(2, "0")}</span>)}{report.weekdayHours.map((row) => <div className={styles.heatRow} key={row.weekday}><div className={styles.productName}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][row.weekday]}</div>{hours.map((hour) => { const count = row.hours[hour]; return <div key={hour} className={styles.weekdayCell} style={{ "--cell-opacity": count ? .18 + .82 * Math.sqrt(count / heatMax) : 0 } as CSSProperties} title={`${number.format(count)} average orders at ${hour}:00 · ${row.occurrences} occurrences`} />; })}</div>)}</div></div><div className={styles.heatFooter}><span>Divided by occurrences of each weekday. Current day, if included, is partial.</span><div className={styles.heatLegend}>Less {[.18, .38, .58, .8, 1].map((value) => <i key={value} style={{ opacity: value }} />)} More</div></div></section>}
    <section className={styles.panel}><h2>Product {monthly ? "contribution" : "performance"}</h2><p className={styles.caption}>Ranked by gross sales</p>{products.length ? <div className={styles.tableScroll}><table className={styles.productTable}><thead><tr><th>Product</th><th>Units</th><th>Gross sales</th><th>Share</th></tr></thead><tbody>{products.slice(0, 10).map((product) => <tr key={product.code}><td>{product.name}</td><td>{number.format(product.units)}</td><td>{money(product.revenue)}</td><td>{revenue > 0 ? `${number.format(product.revenue / revenue * 100)}%` : "—"}</td></tr>)}</tbody></table></div> : <div className={styles.empty}>No product sales recorded in this period.</div>}</section>
  </>;
}
