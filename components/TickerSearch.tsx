"use client";

import LinkedText from "@/components/LinkedText";
import { useEffect, useRef, useState } from "react";
import { chartUrl } from "@/config/links";
import type { Lookup } from "@/lib/scout/lookup";

const cardLink = (id: number) => `/cards/${id}`;

/** Home-page search: the scout's cards on a ticker and what else it knows; with no card, a button to research it now. */
export default function TickerSearch() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState<string | null>(null);
  const [theme, setTheme] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  const [research, setResearch] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  const [sugs, setSugs] = useState<Array<{ symbol: string; name: string; exchange: string }>>([]);
  const [hi, setHi] = useState(-1);
  const [open, setOpen] = useState(false);
  const typed = useRef("");

  // Suggestions as you type (ticker or company name), a beat after the last key.
  useEffect(() => {
    const t = q.trim();
    typed.current = t;
    if (!t) { setSugs([]); return; }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/lookup?suggest=${encodeURIComponent(t)}`).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (typed.current === t) { setSugs(j?.suggestions ?? []); setHi(-1); }
    }, 150);
    return () => clearTimeout(timer);
  }, [q]);

  async function search(e?: React.FormEvent, pick?: string) {
    e?.preventDefault();
    const what = pick ?? (hi >= 0 && sugs[hi] ? sugs[hi].symbol : q.trim());
    if (!what) return;
    if (pick || hi >= 0) setQ(what);
    setOpen(false);
    setBusy(true); setError(null); setResearch("idle"); setNoMatch(null); setTheme("idle");
    const res = await fetch(`/api/lookup?symbol=${encodeURIComponent(what)}`);
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (res.status === 422) { setR(null); return setNoMatch(what); }
    if (!res.ok || !j.ok) { setR(null); return setError((j.errors ?? ["failed"]).join("; ")); }
    setR(j.result);
  }

  /** Not a listed stock (a private company, a product, a theme): the scout finds the listed stocks it moves. */
  async function researchTheme() {
    if (!noMatch) return;
    setTheme("busy");
    const observation = `Vadim searched for "${noMatch}", which is not a US-listed ticker or company name. Work out what it is (a private company, a product, a person, a theme), what is changing about it now, and which listed stocks would move because of it (suppliers, partners, customers, competitors, holders). Say whether there is a trade, which way, and how late it is.`;
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation, term: noMatch.slice(0, 80), kind: null, from: { label: "Home search", url: "/" } }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setTheme(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }

  async function researchIt() {
    if (!r) return;
    setResearch("busy");
    const observation = `Vadim asked the scout to research ${r.symbol}${r.name ? ` (${r.name})` : ""}. Find what is changing for this company now (news, filings, insider and Congress trades, options positioning, public attention, the next catalyst) and say whether there is a trade, which way, and how late it is.${r.news.length ? ` Recent headlines: ${r.news.map((n) => n.headline).join(" | ").slice(0, 600)}.` : ""}`;
    // A dropped connection (phone asleep, page left) does not stop the research on the server: say where it lands.
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation, term: `${r.symbol} on request`, tickers: [r.symbol], kind: null, from: { label: "Home search", url: "/" } }) }).catch(() => null);
    if (!res) { setResearch({ error: `Lost the connection while it ran. The research may still finish: a card shows up on Ideas (and here when you search ${r.symbol} again); a rejection is listed under Desk reports below.` }); return; }
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setResearch(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }

  const extras: Array<[string, string[]]> = r ? [["Insider buys (90 days)", r.insider], ["Congress (90 days)", r.congress], ["Unusual options (30 days)", r.options], ["Trump posts (14 days)", r.truth]] : [];
  return (
    <section className="card ticker-search">
      <form onSubmit={search} className="toolbar" style={{ margin: 0 }}>
        <div className="suggest-wrap">
          <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, sugs.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Ticker or company: NVDA, nvidia, $pltr…" aria-label="Ticker or company" autoComplete="off" role="combobox" aria-expanded={open && sugs.length > 0} style={{ width: 280 }} />
          {open && sugs.length > 0 && (
            <ul className="suggest" role="listbox">
              {sugs.map((s, i) => (
                <li key={s.symbol} role="option" aria-selected={i === hi} className={i === hi ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); search(undefined, s.symbol); }} onMouseEnter={() => setHi(i)}>
                  <b className="ticker">{s.symbol}</b> <span className="secondary">{s.name}</span> <span className="small muted">{s.exchange}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="primary" type="submit" disabled={busy || !q.trim()}>{busy ? "…" : "Search"}</button>
        {error && <span className="small neg"><LinkedText text={error} /></span>}
      </form>
      {noMatch && (
        <div className="small" style={{ marginTop: 8 }}>
          <span className="muted">No US-listed stock matches &ldquo;{noMatch}&rdquo; (it may be private or not listed yet). </span>
          {theme === "idle" && <button className="primary" onClick={researchTheme}>Ask the scout about &ldquo;{noMatch}&rdquo;</button>}
          {theme === "busy" && <span className="muted">Researching which listed stocks it moves… a minute or two.</span>}
          {typeof theme === "object" && (theme.cardId ? <a href={cardLink(theme.cardId)}>card #{theme.cardId}: {String(theme.status).replace("_", " ")}</a> : <span className="neg">{theme.error}</span>)}
        </div>
      )}
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
              {research === "busy" && <span className="muted">Researching… this takes a minute or two. You can leave: the card shows up on Ideas (and here when you search {r.symbol} again); if there is no trade, the reason is under Desk reports below.</span>}
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
