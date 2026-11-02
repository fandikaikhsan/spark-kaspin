"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import styles from "./dashboard.module.css";

// Points are fractions of the anchor's bounds so they stay correct when charts resize.
export function ChartTooltip({ id, anchor, point, outside = false, children }: {
  id: string; anchor: RefObject<Element | null>; point: { x: number; y: number }; outside?: boolean; children: ReactNode;
}) {
  const tooltip = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    function place() {
      const element = anchor.current, tip = tooltip.current;
      if (!element || !tip) return;
      const rect = element.getBoundingClientRect(), size = tip.getBoundingClientRect();
      const width = document.documentElement.clientWidth, height = window.innerHeight, gap = 10;
      const header = document.querySelector("header")?.getBoundingClientRect();
      const nav = document.querySelector('nav[aria-label="Main navigation"]')?.getBoundingClientRect();
      const topEdge = Math.max(8, header && header.top <= 0 ? header.bottom + 8 : 8,
        nav && nav.width > nav.height && nav.top < 150 ? nav.bottom + 8 : 8);
      const x = rect.left + point.x * rect.width, y = rect.top + point.y * rect.height;
      if (y < topEdge || y > height || rect.right < 0 || rect.left > width) { setPosition(null); return; }
      const minX = outside ? 8 : Math.max(8, rect.left);
      const maxX = outside ? width - 8 : Math.min(width - 8, rect.right);
      const clampX = (left: number) => Math.max(minX, Math.min(left, maxX - size.width));
      const above = { left: clampX(x - size.width / 2), top: (outside ? rect.top : y) - size.height - gap };
      const below = { left: clampX(x - size.width / 2), top: (outside ? rect.bottom : y) + gap };
      const right = { left: rect.right + gap, top: Math.max(topEdge, Math.min(y - size.height / 2, height - size.height - 8)) };
      const left = { left: rect.left - size.width - gap, top: right.top };
      const fits = (candidate: { left: number; top: number }) => candidate.left >= 8 && candidate.left + size.width <= width - 8 && candidate.top >= topEdge && candidate.top + size.height <= height - 8;
      const sides = point.x >= .5 ? [right, left] : [left, right];
      const candidates = outside ? [...sides, above, below] : [above, below];
      setPosition(candidates.find(fits) || { left: above.left, top: Math.max(topEdge, Math.min(above.top, height - size.height - 8)) });
    }
    place();
    const observer = new ResizeObserver(place);
    if (anchor.current) observer.observe(anchor.current);
    if (tooltip.current) observer.observe(tooltip.current);
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [anchor, point.x, point.y, outside]);
  return createPortal(<div ref={tooltip} className={styles.chartTooltip} id={id} role="tooltip"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}>{children}</div>, document.body);
}
