"use client";

import { useEffect, useState, type ReactNode } from "react";

const KEY = "scout-collapsed-cards";
const read = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]); } catch { return new Set(); } };
const write = (s: Set<string>) => { try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-500))); } catch { /* storage unavailable */ } };

/** A card that folds down to its header (status, ticker, price, title). Remembered per card; "collapse all" reaches every card on the page. */
export default function CardCollapse({ id, children }: { id: number; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // A card opened from a link (#card-N) always starts open.
    setCollapsed(read().has(String(id)) && location.hash !== `#card-${id}`);
    const on = (e: Event) => set((e as CustomEvent<boolean>).detail);
    window.addEventListener("cards:collapse", on);
    return () => window.removeEventListener("cards:collapse", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  function set(v: boolean) {
    setCollapsed(v);
    const s = read();
    if (v) s.add(String(id)); else s.delete(String(id));
    write(s);
  }
  return (
    <section className={`card thesis${collapsed ? " collapsed" : ""}`} id={`card-${id}`}>
      <button type="button" className="collapse-btn" aria-expanded={!collapsed} aria-label={collapsed ? "Expand card" : "Collapse card"} title={collapsed ? "Expand" : "Collapse"} onClick={() => set(!collapsed)}>{collapsed ? "▸" : "▾"}</button>
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
