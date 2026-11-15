"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { chartUrl } from "@/config/links";
import type { FeedItem } from "@/lib/scout/newsfeed";

const POLL_MS = 30_000;
const when = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
};

export default function NewsFeed({ initial }: { initial: FeedItem[] }) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"top" | "latest">("top");
  const [mine, setMine] = useState(false);
  const [checked, setChecked] = useState<Date>(new Date());
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const unseen = useRef(0);

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch("/api/news", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error((j.errors ?? [`HTTP ${r.status}`]).join("; "));
        setItems((old) => {
          const known = new Set(old.map((i) => i.id));
          const added = (j.items as FeedItem[]).filter((i) => !known.has(i.id));
          if (added.length) {
            setFresh((f) => new Set([...f, ...added.map((i) => i.id)]));
            if (document.hidden) { unseen.current += added.length; document.title = `(${unseen.current}) News · Trend scout`; }
          }
          return j.items as FeedItem[];
        });
        setChecked(new Date());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    const id = setInterval(poll, POLL_MS);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    const seen = () => { if (!document.hidden) { unseen.current = 0; document.title = "News · Trend scout"; } };
    document.addEventListener("visibilitychange", seen);
    return () => { clearInterval(id); clearInterval(clock); document.removeEventListener("visibilitychange", seen); };
  }, []);

  const shown = useMemo(() => {
    const xs = items.filter((i) => !mine || i.cardIds.length > 0);
    return xs.slice().sort((a, b) => (view === "top" ? b.score - a.score : 0) || b.at.localeCompare(a.at)).slice(0, 120);
  }, [items, view, mine]);

  return (
    <div className="news">
      <div className="toolbar">
        <span className="filter-links small">
          <button className={`chip${view === "top" ? " active" : ""}`} onClick={() => setView("top")}>Top</button>
          <button className={`chip${view === "latest" ? " active" : ""}`} onClick={() => setView("latest")}>Latest</button>
          <button className={`chip${mine ? " active" : ""}`} onClick={() => setMine((m) => !m)}>On my cards only</button>
        </span>
        <span className="small muted">Live: checks every 30 seconds · last {checked.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}{error ? <span className="warn"> · {error}</span> : null}</span>
      </div>
      {shown.length === 0 && <p className="small muted">{mine ? "No headlines on your cards' stocks in the last 24 hours." : "No headlines yet (the news stream needs the Alpaca keys)."}</p>}
      {shown.map((i) => (
        <article key={i.id} className={`news-item card${fresh.has(i.id) ? " fresh" : ""}`} onMouseEnter={() => fresh.has(i.id) && setFresh((f) => { const g = new Set(f); g.delete(i.id); return g; })}>
          <div className="news-meta small muted">
            {fresh.has(i.id) && <span className="tag ok">new</span>}
            {i.kind === "trump" && <span className="tag late">Trump</span>}
            {i.event && <span className="tag">{i.event}</span>}
            {i.buzz >= 3 && <span className="tag warn" title="headlines on this stock in the last 6 hours">{i.buzz} in 6h</span>}
            {i.cardIds.map((id) => <a key={id} className="tag promoted" href={`/ideas?days=30&card=${id}#card-${id}`}>card #{id}</a>)}
            <span>{when(i.at)} · {i.source}</span>
          </div>
          <div className="news-headline"><a href={i.url} target="_blank" rel="noreferrer">{i.headline}</a></div>
          {i.symbols.length > 0 && <div className="small">{i.symbols.map((s, j) => <span key={s}>{j ? " · " : ""}<a className="ticker accent" href={chartUrl(s)} target="_blank" rel="noreferrer">{s}</a></span>)}</div>}
          {i.summary && <div className="small secondary news-summary">{i.summary.slice(0, 320)}{i.summary.length > 320 ? "…" : ""}</div>}
        </article>
      ))}
    </div>
  );
}
