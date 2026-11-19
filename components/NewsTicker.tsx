"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { chartUrl } from "@/config/links";

interface Item { id: string; at: string; headline: string; url: string; symbols: string[]; source: string; why: string; kind: string }

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const NEW_FOR_MS = 15 * 60_000;

/** The running breaking-news ticker under the menu: the last 3 hours' breaking stories, checked every 15 seconds. */
export default function NewsTicker() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState(false);
  // When each story first appeared in the ticker (stories already there on the first load are not "new").
  const firstSeen = useRef<Map<string, number> | null>(null);
  const [, tick] = useState(0);
  const path = usePathname();

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/news?breaking=1", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error();
        if (stop) return;
        const list = j.items as Item[];
        const now = Date.now();
        if (!firstSeen.current) firstSeen.current = new Map(list.map((i) => [i.id, 0]));
        else for (const i of list) if (!firstSeen.current.has(i.id)) firstSeen.current.set(i.id, now);
        setItems(list);
        setError(false);
      } catch {
        if (!stop) setError(true);
      }
    };
    poll();
    const t = setInterval(() => (document.hidden ? undefined : poll()), 30_000);
    const v = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", v);
    const clock = setInterval(() => tick((n) => n + 1), 60_000);
    return () => { stop = true; clearInterval(t); clearInterval(clock); document.removeEventListener("visibilitychange", v); };
  }, []);

  if (path === "/login") return null;
  const isNew = (id: string) => { const at = firstSeen.current?.get(id) ?? 0; return at > 0 && Date.now() - at < NEW_FOR_MS; };
  // New stories first, then newest first (the server's order).
  const shown = (items ?? []).slice().sort((a, b) => Number(isNew(b.id)) - Number(isNew(a.id)));
  const chars = shown.reduce((n, i) => n + i.headline.length + 30, 0);
  // About 100 characters a second, whatever the number of stories.
  const duration = Math.max(28, Math.round(chars / 10));

  const row = (copy: number) => shown.map((i) => (
    // Each ticker opens its chart (TradingView); the headline opens the story.
    <span key={`${copy}-${i.id}`} className={`newsbar-item${isNew(i.id) ? " is-new" : ""}`} aria-hidden={copy ? true : undefined}>
      {isNew(i.id) && <span className="newsbar-new">NEW</span>}
      <span className="newsbar-time">{time(i.at)}</span>
      {i.symbols.length > 0 && <span className="newsbar-sym">{i.symbols.map((sym, k) => <a key={sym} href={chartUrl(sym)} target="_blank" rel="noreferrer" tabIndex={copy ? -1 : 0} title={`${sym} chart on TradingView`}>{k ? " " : ""}{sym}</a>)}</span>}
      <a className="newsbar-headline" href={i.url} target="_blank" rel="noreferrer" tabIndex={copy ? -1 : 0} title={`${i.source} · ${new Date(i.at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`}>{i.headline}</a>
      {i.why && <span className="newsbar-why">{i.why}</span>}
    </span>
  ));

  return (
    <div className="newsbar" role="region" aria-label="Breaking news">
      <div className="newsbar-viewport">
        {items === null ? <span className="newsbar-empty">{error ? "News feed not reachable; retrying…" : "Loading breaking news…"}</span>
          : shown.length === 0 ? <span className="newsbar-empty">No breaking stories in the last 3 hours.</span>
          : <div className="newsbar-track" style={{ ["--newsbar-duration" as string]: `${duration}s` }}>{row(0)}{row(1)}</div>}
      </div>
      <a className="newsbar-more" href="/news">All news →</a>
    </div>
  );
}
