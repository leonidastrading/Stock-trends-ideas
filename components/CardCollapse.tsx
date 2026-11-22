"use client";

import { useEffect, useState, type ReactNode } from "react";

const KEY = "scout-collapsed-cards";
/** Cards opened by hand while "collapse all" is the default. */
const OPEN_KEY = "scout-opened-cards";
/** "collapsed" after Collapse all: every card, including ones not on the page then, starts folded. */
const MODE_KEY = "scout-cards-default";
const readSet = (k: string): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(k) ?? "[]") as string[]); } catch { return new Set(); } };
const writeSet = (k: string, s: Set<string>) => { try { localStorage.setItem(k, JSON.stringify([...s].slice(-500))); } catch { /* storage unavailable */ } };
const read = () => readSet(KEY);
const write = (s: Set<string>) => writeSet(KEY, s);
const collapsedByDefault = () => { try { return localStorage.getItem(MODE_KEY) === "collapsed"; } catch { return false; } };
/** Pure: is a card folded? Its own choice first, then the default. */
export const isCollapsed = (key: string, collapsed: Set<string>, opened: Set<string>, byDefault: boolean) => (collapsed.has(key) ? true : opened.has(key) ? false : byDefault);

/** A card that folds down to its header (status, ticker, price, title). Remembered per card; "collapse all" reaches every card on the page. */
export default function CardCollapse({ id, children, prefix = "card", className = "" }: { id: number; children: ReactNode; prefix?: string; className?: string }) {
  const key = prefix === "card" ? String(id) : `${prefix}-${id}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // A card opened from a link (#card-N) always starts open.
    const linked = location.hash === `#${prefix}-${id}`;
    setCollapsed(!linked && isCollapsed(key, read(), readSet(OPEN_KEY), collapsedByDefault()));
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
    const on = (e: Event) => setCollapsed((e as CustomEvent<boolean>).detail);
    window.addEventListener("cards:collapse", on);
    return () => { window.removeEventListener("cards:collapse", on); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, prefix]);
  function set(v: boolean) {
    setCollapsed(v);
    const s = read(), o = readSet(OPEN_KEY);
    if (v) { s.add(key); o.delete(key); } else { s.delete(key); o.add(key); }
    write(s);
    writeSet(OPEN_KEY, o);
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
  // Remembered as the default for every card (also ones on other pages or written later); each card's own choice is reset.
  const fire = (v: boolean) => {
    try { localStorage.setItem(MODE_KEY, v ? "collapsed" : "expanded"); localStorage.removeItem(KEY); localStorage.removeItem(OPEN_KEY); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent("cards:collapse", { detail: v }));
  };
  return (
    <span className="small">
      <button type="button" className="chip" onClick={() => fire(true)}>Collapse all</button>{" "}
      <button type="button" className="chip" onClick={() => fire(false)}>Expand all</button>
    </span>
  );
}
