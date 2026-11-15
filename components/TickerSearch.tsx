"use client";

import { useState } from "react";
import { chartUrl } from "@/config/links";
import type { Lookup } from "@/lib/scout/lookup";

const cardLink = (id: number) => `/ideas?days=365&card=${id}#card-${id}`;

/** Home-page search: the scout's cards on a ticker and what else it knows; with no card, a button to research it now. */
export default function TickerSearch() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [research, setResearch] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setError(null); setResearch("idle");
    const res = await fetch(`/api/lookup?symbol=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) { setR(null); return setError((j.errors ?? ["failed"]).join("; ")); }
    setR(j.result);
  }

  async function researchIt() {
    if (!r) return;
    setResearch("busy");
    const observation = `Vadim asked the scout to research ${r.symbol}${r.name ? ` (${r.name})` : ""}. Find what is changing for this company now (news, filings, insider and Congress trades, options positioning, public attention, the next catalyst) and say whether there is a trade, which way, and how late it is.${r.news.length ? ` Recent headlines: ${r.news.map((n) => n.headline).join(" | ").slice(0, 600)}.` : ""}`;
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation, term: `${r.symbol} on request`, tickers: [r.symbol], kind: null }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setResearch(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }

  const extras: Array<[string, string[]]> = r ? [["Insider buys (90 days)", r.insider], ["Congress (90 days)", r.congress], ["Unusual options (30 days)", r.options], ["Trump posts (14 days)", r.truth]] : [];
  return (
    <section className="card ticker-search">
      <form onSubmit={search} className="toolbar" style={{ margin: 0 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a ticker: NVDA, $pltr…" aria-label="Ticker" style={{ width: 240 }} />
        <button className="primary" type="submit" disabled={busy || !q.trim()}>{busy ? "…" : "Search"}</button>
        {error && <span className="small neg">{error}</span>}
      </form>
      {r && (
        <div style={{ marginTop: 10 }}>
          <div>
            <a className="ticker accent" href={chartUrl(r.symbol)} target="_blank" rel="noreferrer" style={{ fontSize: 18 }}>{r.symbol}</a>{" "}
            <span className="secondary">{r.name ?? ""}</span>
            {r.nextEarnings && <span className="small muted"> · next earnings ~{r.nextEarnings}</span>}
          </div>
          {r.cards.length > 0 ? (
            <ul className="small" style={{ margin: "6px 0", paddingLeft: 18 }}>
              {r.cards.map((c) => (
                <li key={c.id}>
                  <a href={cardLink(c.id)}>card #{c.id}</a> <span className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲ long" : "▼ short"}</span> <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span> confidence {c.confidence} · {c.title} <span className="muted">· {c.createdAt.slice(0, 10)}{c.primary ? "" : ` · ${r.symbol} is a secondary ticker`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="small" style={{ margin: "6px 0" }}>
              <span className="muted">No cards on {r.symbol} yet. </span>
              {research === "idle" && <button className="primary" onClick={researchIt}>Research {r.symbol}</button>}
              {research === "busy" && <span className="muted">Researching… this takes a minute or two.</span>}
              {typeof research === "object" && (research.cardId ? <a href={cardLink(research.cardId)}>card #{research.cardId}: {String(research.status).replace("_", " ")}</a> : <span className="neg">{research.error}</span>)}
            </div>
          )}
          {extras.filter(([, xs]) => xs.length).map(([label, xs]) => (
            <div key={label} className="small"><b>{label}:</b> <span className="secondary">{xs.slice(0, 4).join(" · ")}{xs.length > 4 ? ` · +${xs.length - 4} more` : ""}</span></div>
          ))}
          {r.news.length > 0 && (
            <div className="small"><b>Today&apos;s headlines:</b> {r.news.map((n, i) => <span key={n.url + i}>{i ? " · " : ""}<a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a></span>)}</div>
          )}
          {!r.cards.length && !extras.some(([, xs]) => xs.length) && !r.news.length && <div className="small muted">Nothing else on file for {r.symbol} either.</div>}
        </div>
      )}
    </section>
  );
}
