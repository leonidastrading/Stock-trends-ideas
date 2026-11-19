"use client";

import { useEffect, useState, type ReactNode } from "react";

const KEY = "scout-collapsed-cards";
const read = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]); } catch { return new Set(); } };
const write = (s: Set<string>) => { try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-500))); } catch { /* storage unavailable */ } };

/** A card that folds down to its header (status, ticker, price, title). Remembered per card; "collapse all" reaches every card on the page. */
export default function CardCollapse({ id, children, prefix = "card", className = "" }: { id: number; children: ReactNode; prefix?: string; className?: string }) {
  const key = prefix === "card" ? String(id) : `${prefix}-${id}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // A card opened from a link (#card-N) always starts open.
    const linked = location.hash === `#${prefix}-${id}`;
    setCollapsed(read().has(key) && !linked);
    // Opened from a link: the page streams in, so the browser's own jump to #card-N can miss; scroll here and flash it.
    let t: ReturnType<typeof setTimeout> | undefined;
    if (linked) {
      t = setTimeout(() => {
        const el = document.getElementById(`${prefix}-${id}`);
        if (!el) return;
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        el.classList.add("card-linked");
        setTimeout(() => el.classList.remove("card-linked"), 2600);
      }, 60);
    }
    const on = (e: Event) => set((e as CustomEvent<boolean>).detail);
    window.addEventListener("cards:collapse", on);
    return () => { window.removeEventListener("cards:collapse", on); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, prefix]);
  function set(v: boolean) {
    setCollapsed(v);
    const s = read();
    if (v) s.add(key); else s.delete(key);
    write(s);
  }
  return (
    <section className={`card thesis${className ? ` ${className}` : ""}${collapsed ? " collapsed" : ""}`} id={`${prefix}-${id}`}>
      <button type="button" className="collapse-btn" aria-expanded={!collapsed} aria-label={collapsed ? "Expand" : "Collapse"} title={collapsed ? "Expand" : "Collapse"} onClick={() => set(!collapsed)}>{collapsed ? "▸" : "▾"}</button>
      {children}
    </section>
  );
}

/** Collapse or expand every card on the page. */
export function CollapseAll() {
  const fire = (v: boolean) => window.dispatchEvent(new CustomEvent("cards:collapse", { detail: v }));
  return (
    <span className="small">
      <button type="button" className="chip" onClick={() => fire(true)}>Collapse all</button>{" "}
      <button type="button" className="chip" onClick={() => fire(false)}>Expand all</button>
    </span>
  );
}
