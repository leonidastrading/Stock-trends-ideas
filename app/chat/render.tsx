import type { ReactNode } from "react";
import { chartUrl } from "@/config/links";

/**
 * A small, safe renderer for the chat's replies (no HTML is injected): headings, bullet and numbered lists,
 * paragraphs, **bold**, `code`, tickers in colour (only symbols the scout knows, or written as $XYZ) and
 * "card #N" as a link to the card.
 */
export function renderReply(text: string, tickers: ReadonlySet<string>, cards?: ReadonlyMap<string, number>): ReactNode {
  // Each stock's card link appears once per reply, at its first mention.
  const ctx: Ctx = { cards, shown: new Set() };
  const blocks: ReactNode[] = [];
  // A list keeps going across blank lines; bullets under a numbered item nest inside it, so numbering never restarts.
  let list: { ordered: boolean; items: Array<{ n: number | null; body: ReactNode; sub: ReactNode[] }> } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join(" "), tickers, ctx)}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      <li key={i} value={it.n ?? undefined}>{it.body}{it.sub.length ? <ul>{it.sub.map((s, j) => <li key={j}>{s}</li>)}</ul> : null}</li>
    ));
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,4}\s+(.*)$/) ?? line.match(/^\s*\*\*([^*]+)\*\*:?\s*$/);
    if (!line.trim()) { flushPara(); continue; }
    if (heading) { flushPara(); flushList(); blocks.push(<h4 key={blocks.length}>{inline(heading[1], tickers, ctx)}</h4>); continue; }
    if (numbered) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push({ n: Number(numbered[1]), body: inline(numbered[2], tickers, ctx), sub: [] });
      continue;
    }
    if (bullet) {
      flushPara();
      if (list?.ordered && list.items.length) { list.items[list.items.length - 1].sub.push(inline(bullet[1], tickers, ctx)); continue; }
      if (!list) list = { ordered: false, items: [] };
      list.items.push({ n: null, body: inline(bullet[1], tickers, ctx), sub: [] });
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}

/** Symbols that are also common words or acronyms in replies: coloured only when written as $XYZ. */
const AMBIGUOUS = new Set(["AI", "IT", "ET", "AM", "PM", "US", "OR", "ON", "ARE", "BE", "SO", "GO", "CEO", "EPS", "ETF", "IPO", "GDP", "CPI", "PPI", "FOMC", "SEC", "FDA", "EU", "UK", "NOW", "ALL", "ONE", "KEY", "CAN", "WELL", "LOW", "HIGH", "NEW", "BIG", "MAIN", "PLAY", "SEE", "TWO", "OUT",
  "ETN", "NAV", "PIK", "CRL", "ATC", "ESG", "LLC", "CIO", "CFO", "COO", "CTO", "DOJ", "FTC", "FAA", "DOT", "IRS", "NYSE", "OTC", "YOY", "QOQ", "TTM", "API", "USD", "EUR", "DD", "IV", "OI", "ATH", "EOD", "PE", "PT", "FED", "BDC", "BDCS", "NONE", "TBD", "FAQ", "ROI", "ROE", "EV", "NOI", "FFO", "AUM", "SPAC", "REIT", "ADR", "ESOP", "CEOS", "HQ", "PR", "TV", "UN", "WHO", "NATO", "OPEC", "IMF", "ECB", "BOJ", "RV", "LEAP", "LEAPS", "DTE", "OTM", "ITM", "ATM", "VIX", "IG", "HY", "CDS", "CLO", "MBS", "GSE", "FX", "PCE", "ISM", "PMI", "JOLTS", "NFP", "QE", "QT", "BPS", "CAGR", "CAPEX", "OPEX", "GAAP", "FCF", "EBIT", "EBITDA", "TAM", "SAAS", "ARR", "MRR", "LTV", "CAC"]);

const TOKEN =/(\*\*[^*]+?\*\*)|(`[^`]+`)|(\bcards? #\d+(?:\s*(?:,|and|\/)\s*#\d+)*)|(#\d{1,5}\b)|(\$?\b[A-Z]{1,5}(?:\.[A-Z])?\b)/g;

/** Inline pieces: bold, code, card links and coloured tickers. */
interface Ctx { cards?: ReadonlyMap<string, number>; shown: Set<string> }

export function inline(text: string, tickers: ReadonlySet<string>, ctx: Ctx = { shown: new Set() }): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index!;
    if (i > last) out.push(text.slice(last, i));
    const k = out.length;
    if (m[1]) out.push(<b key={k}>{inline(m[1].slice(2, -2), tickers, ctx)}</b>);
    else if (m[2]) out.push(<code key={k}>{m[2].slice(1, -1)}</code>);
    else if (m[3] || m[4]) {
      const s = m[3] ?? m[4];
      out.push(...s.split(/(#\d+)/).map((part, j) => (/^#\d+$/.test(part) ? <a key={`${k}-${j}`} href={`/cards/${part.slice(1)}`}>{part}</a> : part)));
    } else {
      const sym = m[5].replace(/^\$/, "");
      const known = tickers.has(sym) && sym.length > 1 && !AMBIGUOUS.has(sym);
      if (m[5].startsWith("$") || known) {
        out.push(<a key={k} className="ticker accent" href={chartUrl(sym)} target="_blank" rel="noreferrer">{m[5]}</a>);
        const card = ctx.cards?.get(sym);
        if (card && !ctx.shown.has(sym)) {
          ctx.shown.add(sym);
          out.push(<a key={`${k}-card`} className="card-chip" href={`/cards/${card}`} title={`The scout's latest card on ${sym}`}>card #{card}</a>);
        }
      } else out.push(m[5]);
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
