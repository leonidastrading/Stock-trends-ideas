"use client";

import { useEffect, useRef, useState } from "react";
import { fmtEtAgo } from "@/lib/time";

interface Item { at: string; headline: string; source: string; url: string; symbols: string[] }

const EVERY_MS = 120_000;

/**
 * A card's latest news: headlines on its stocks, newest first. Loads when the card comes into view, then asks again
 * every 2 minutes while the page is open and visible; headlines that arrived while you were looking are marked new.
 */
export default function CardNews({ symbols, since, window: span }: { symbols: string[]; since: string; window?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const key = symbols.join(",");

  useEffect(() => {
    const el = box.current;
    if (!el || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: "200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let dead = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await fetch(`/api/news?symbols=${encodeURIComponent(key)}&since=${encodeURIComponent(since)}`, { cache: "no-store" }).catch(() => null);
      const j = r ? await r.json().catch(() => null) : null;
      if (dead || !j?.ok) return;
      const list = j.items as Item[];
      if (known.current) {
        const added = list.filter((x) => !known.current!.has(x.url + x.headline)).map((x) => x.url + x.headline);
        if (added.length) setFresh((f) => new Set([...f, ...added]));
      }
      known.current = new Set(list.map((x) => x.url + x.headline));
      setItems(list);
    };
    void load();
    const t = setInterval(load, EVERY_MS);
    return () => { dead = true; clearInterval(t); };
  }, [visible, key, since]);

  const after = items?.filter((x) => x.at >= since) ?? [];
  const shown = items ? (all ? items : items.slice(0, 5)) : [];
  return (
    <div ref={box} className="card-news">
      <h3>Latest news <span className="small muted">on {symbols.join(", ")}{items ? ` · ${after.length} ${span ? `in ${span}` : "since the card was written"} · checks every 2 minutes` : ""}</span></h3>
      {items === null ? <p className="small muted">Loading headlines…</p>
        : items.length === 0 ? <p className="small muted">No headlines on {symbols.join(", ")} {span ? `in ${span}` : "since the card was written"}.</p>
        : (
          <ul className="card-news-list">
            {shown.map((x) => (
              <li key={x.url + x.headline} className={x.at < since && !span ? "muted" : undefined}>
                {fresh.has(x.url + x.headline) && <span className="tag error">new</span>}{" "}
                <a href={x.url} target="_blank" rel="noreferrer">{x.headline}</a>{" "}
                <span className="small muted">{x.source} · {fmtEtAgo(x.at)}{x.at < since && !span ? " · before the card" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      {items && items.length > 5 && <button type="button" className="link-button small" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>}
    </div>
  );
}
