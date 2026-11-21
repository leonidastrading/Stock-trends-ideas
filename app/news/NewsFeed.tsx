"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ResearchButton from "@/app/filings/ResearchButton";
import { chartUrl } from "@/config/links";
import type { FeedItem } from "@/lib/scout/newsfeed";
import { useStoredState } from "@/components/useStoredState";
import { isTopStory } from "@/lib/scout/top-story";
import { ago, fmtEtAgo, toEt } from "@/lib/time";

const PAGE_SIZE = 10;

const POLL_MS = 15_000;
/** Today: how long ago only ("25m ago", "3h ago"); earlier: the date with how many days ago. */
/** The actual time (ET) and how long ago: "4:02 PM ET · 4h ago" today, "Nov 19, 4:02 PM ET · 1 day ago" before. */
const when = (iso: string) => {
  const d = new Date(iso);
  if (toEt(d).date !== toEt(new Date()).date) return fmtEtAgo(iso);
  return `${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET · ${ago(iso)}`;
};

export default function NewsFeed({ initial }: { initial: FeedItem[] }) {
  const [items, setItems] = useState<FeedItem[]>(initial);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [view, setView] = useStoredState<"top" | "latest">("news-view", "top");
  const [mine, setMine] = useStoredState("news-mine", false);
  const [checked, setChecked] = useState<Date>(new Date());
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const unseen = useRef(0);
  const [page, setPage] = useState(0);
  const top = useRef<HTMLDivElement>(null);

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
    let lastPoll = Date.now();
    const id = setInterval(() => { if (!document.hidden || Date.now() - lastPoll > 120_000) { lastPoll = Date.now(); void poll(); } }, POLL_MS);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    const seen = () => { if (!document.hidden) { unseen.current = 0; document.title = "News · Trend scout"; } };
    document.addEventListener("visibilitychange", seen);
    return () => { clearInterval(id); clearInterval(clock); document.removeEventListener("visibilitychange", seen); };
  }, []);

  const shown = useMemo(() => {
    const xs = items.filter((i) => !mine || i.cardIds.length > 0);
    // Top: only the top stories (big moves, events, your card stocks, pile-ups, Trump); both views newest first.
    return xs.filter((i) => view !== "top" || isTopStory(i)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 120);
  }, [items, view, mine]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);
  const pageItems = shown.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
  const go = (n: number) => { setPage(n); top.current?.scrollIntoView({ block: "start" }); };
  const pager = pages > 1 && (
    <nav className="small pager news-pager" aria-label="News pages">
      <button className="chip" disabled={at === 0} onClick={() => go(at - 1)}>← Newer</button>
      {Array.from({ length: pages }, (_, n) => n).filter((n) => n === 0 || n === pages - 1 || Math.abs(n - at) <= 2).map((n, k, arr) => (
        <span key={n}>{k && n - arr[k - 1] > 1 ? <span className="muted"> … </span> : null}<button className={`chip${n === at ? " active" : ""}`} aria-current={n === at ? "page" : undefined} onClick={() => go(n)}>{n + 1}</button></span>
      ))}
      <button className="chip" disabled={at >= pages - 1} onClick={() => go(at + 1)}>Older →</button>
      <span className="muted">{shown.length} stories</span>
    </nav>
  );

  return (
    <div className="news" ref={top}>
      <div className="toolbar">
        <span className="filter-links small">
          <button className={`chip${view === "top" ? " active" : ""}`} onClick={() => { setView("top"); setPage(0); }}>Top</button>
          <button className={`chip${view === "latest" ? " active" : ""}`} onClick={() => { setView("latest"); setPage(0); }}>Latest</button>
          <button className={`chip${mine ? " active" : ""}`} onClick={() => { setMine(!mine); setPage(0); }}>On my cards only</button>
        </span>
        <span className="small muted" suppressHydrationWarning>Live: checks every 15 seconds · last {checked.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}{error ? <span className="warn"> · {error}</span> : null}</span>
      </div>
      {items.length > 0 && (() => {
        // How fresh each source is: a lagging feed shows at a glance.
        const newest = new Map<string, string>();
        for (const i of items) if (!i.repostedAt && i.kind === "news" && (!newest.has(i.source) || i.at > newest.get(i.source)!)) newest.set(i.source, i.at);
        const list = [...newest].sort((a, b) => b[1].localeCompare(a[1])).slice(0, 6);
        return <p className="small muted" style={{ margin: "0 0 8px" }}>Newest by source: {list.map(([src, at], k) => <span key={src} suppressHydrationWarning>{k ? " · " : ""}{src} {when(at)}</span>)}</p>;
      })()}
      {shown.length === 0 && <p className="small muted">{mine ? "No headlines on your cards' stocks in the last 24 hours." : "No headlines yet (the news stream needs the Alpaca keys)."}</p>}
      {pager}
      {pageItems.map((i) => (
        <article key={i.id} className={`news-item card${fresh.has(i.id) ? " fresh" : ""}`} onMouseEnter={() => fresh.has(i.id) && setFresh((f) => { const g = new Set(f); g.delete(i.id); return g; })}>
          <div className="news-meta small muted">
            {fresh.has(i.id) && <span className="tag ok">new</span>}
            {i.kind === "trump" && <span className="tag late">Trump</span>}
            {i.kind === "rumor" && <a className="tag" href="/rumors?truth=already_news" title="Found in your rumor sources; already reported by this outlet">from rumors</a>}
            {i.event && <span className="tag">{i.event}</span>}
            {i.buzz >= 3 && <span className="tag warn" title="headlines on this stock in the last 6 hours">{i.buzz} in 6h</span>}
            {(i.cardRefs ?? i.cardIds.map((id) => ({ id, ticker: "", direction: "long" as const, via: null }))).slice(0, 3).map((r) => (
              <a key={r.id} className="tag promoted" href={`/ideas?days=30&card=${r.id}#card-${r.id}`} title={r.ticker ? `Card #${r.id}: ${r.direction} ${r.ticker}${r.via ? `. The card also names ${r.via}, which this story is about` : ""}` : undefined}>
                card #{r.id}{r.ticker ? <> · <span className={r.direction === "long" ? "pos" : "neg"}>{r.direction === "long" ? "▲" : "▼"}</span> {r.ticker}</> : null}{r.via ? <span className="muted"> (names {r.via})</span> : null}
              </a>
            ))}
            {i.cardIds.length > 3 && <span className="tag" title={i.cardIds.slice(3).map((id) => `#${id}`).join(", ")}>+{i.cardIds.length - 3} more cards</span>}
            <span suppressHydrationWarning>{i.repostedAt ? <><span className="tag late" title={`Re-posted ${when(i.repostedAt)}; the news itself is from ${new Date(i.at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" })}`}>old news, re-posted</span> {new Date(i.at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" })} · re-posted {when(i.repostedAt)}</> : when(i.at)} · {i.source}</span>
            <span className="news-action"><ResearchButton from={{ label: i.kind === "trump" ? "Trump post" : "News", url: i.url || "/news" }} ticker={i.symbols.length <= 3 ? i.symbols[0] : null} observation={`${i.kind === "trump" ? "Trump post on Truth Social" : `News headline (${i.source})`}, ${new Date(i.at).toISOString().slice(0, 16).replace("T", " ")} UTC: ${i.headline}.${i.summary ? ` ${i.summary.slice(0, 600)}` : ""}${i.symbols.length ? ` Tickers tagged: ${i.symbols.join(", ")}.` : ""} Link: ${i.url}`} /></span>
          </div>
          <div className="news-headline"><a href={i.url} target="_blank" rel="noreferrer">{i.headline}</a></div>
          {i.symbols.length > 0 && <div className="small">{i.symbols.map((s, j) => <span key={s}>{j ? " · " : ""}<a className="ticker accent" href={chartUrl(s)} target="_blank" rel="noreferrer">{s}</a></span>)}</div>}
          {i.summary && <div className="small secondary news-summary">{i.summary.slice(0, 320)}{i.summary.length > 320 ? "…" : ""}</div>}
        </article>
      ))}
      {pager}
    </div>
  );
}
