import type { ReactNode } from "react";

/**
 * A small, safe renderer for the chat's replies (no HTML is injected): headings, bullet and numbered lists,
 * paragraphs, **bold**, `code`, tickers in colour (only symbols the scout knows, or written as $XYZ) and
 * "card #N" as a link to the card.
 */
export function renderReply(text: string, tickers: ReadonlySet<string>): ReactNode {
  const blocks: ReactNode[] = [];
  // A list keeps going across blank lines; bullets under a numbered item nest inside it, so numbering never restarts.
  let list: { ordered: boolean; items: Array<{ n: number | null; body: ReactNode; sub: ReactNode[] }> } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join(" "), tickers)}</p>); para = []; } };
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
    if (heading) { flushPara(); flushList(); blocks.push(<h4 key={blocks.length}>{inline(heading[1], tickers)}</h4>); continue; }
    if (numbered) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push({ n: Number(numbered[1]), body: inline(numbered[2], tickers), sub: [] });
      continue;
    }
    if (bullet) {
      flushPara();
      if (list?.ordered && list.items.length) { list.items[list.items.length - 1].sub.push(inline(bullet[1], tickers)); continue; }
      if (!list) list = { ordered: false, items: [] };
      list.items.push({ n: null, body: inline(bullet[1], tickers), sub: [] });
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
const AMBIGUOUS = new Set(["AI", "IT", "ET", "AM", "PM", "US", "OR", "ON", "ARE", "BE", "SO", "GO", "CEO", "EPS", "ETF", "IPO", "GDP", "CPI", "PPI", "FOMC", "SEC", "FDA", "EU", "UK", "NOW", "ALL", "ONE", "KEY", "CAN", "WELL", "LOW", "HIGH", "NEW", "BIG", "MAIN", "PLAY", "SEE", "TWO", "OUT"]);

const TOKEN =/(\*\*[^*]+?\*\*)|(`[^`]+`)|(\bcards? #\d+(?:\s*(?:,|and|\/)\s*#\d+)*)|(#\d{1,5}\b)|(\$?\b[A-Z]{1,5}(?:\.[A-Z])?\b)/g;

/** Inline pieces: bold, code, card links and coloured tickers. */
export function inline(text: string, tickers: ReadonlySet<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index!;
    if (i > last) out.push(text.slice(last, i));
    const k = out.length;
    if (m[1]) out.push(<b key={k}>{inline(m[1].slice(2, -2), tickers)}</b>);
    else if (m[2]) out.push(<code key={k}>{m[2].slice(1, -1)}</code>);
    else if (m[3] || m[4]) {
      const s = m[3] ?? m[4];
      out.push(...s.split(/(#\d+)/).map((part, j) => (/^#\d+$/.test(part) ? <a key={`${k}-${j}`} href={`/candidates?days=365#card-${part.slice(1)}`}>{part}</a> : part)));
    } else {
      const sym = m[5].replace(/^\$/, "");
      const known = tickers.has(sym) && sym.length > 1 && !AMBIGUOUS.has(sym);
      out.push(m[5].startsWith("$") || known ? <b key={k} className="accent">{m[5]}</b> : m[5]);
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
