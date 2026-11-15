/**
 * Idea map: which of the scout's sources point at which stocks. Each stock carries the list of sources that
 * flag it (with a short note each) and, if it has one, its newest card. Built from stored data and the
 * dashboard caches only, so the page makes no outside calls.
 */
import { addDays, toEt } from "../time";
import type { MapSourceKey } from "./map-sources";
import { newsFeed } from "./newsfeed";
import * as store from "./store";


export { MAP_SOURCES, type MapSourceKey } from "./map-sources";

export interface MapNode { symbol: string; links: Array<{ source: MapSourceKey; note: string }>; cardId: number | null; direction: "long" | "short" | null; status: string | null; confidence: number | null }

/** Pure: exactly where a card came from (the document, story, watch-list term or signal) and which data its research used. */
export function cardNote(c: { id: number; direction: string; status: string; card: { confidence: number; evidence: Array<{ source: string }> } }, source: MapSourceKey, term: string, observation: string | null): string {
  const what = term.replace(/^(story|inbox|filing|insider|options|congress|insider\+congress|truth): /i, "").replace(/ → .*$/, "");
  const doc = observation?.match(/inbox document "([^"]+)"/)?.[1];
  const origin = source === "inbox" ? `${doc ? `document "${doc}"` : "a document"}, idea "${what}"`
    : source === "you" ? (observation && /pasted in/.test(observation) ? `text you pasted, idea "${what}"` : `your note "${(observation ?? what).slice(0, 70)}"`)
      : source === "story" ? `story "${what}"`
        : source === "trend" ? `watch-list / discovery term "${what}"`
          : `signal "${what}"`;
  const used = [...new Set(c.card.evidence.map((e) => e.source.toLowerCase()))].join(", ");
  return `card #${c.id} ${c.direction} (${c.status.replace("_", " ")}), confidence ${c.card.confidence} · from ${origin}${used ? ` · evidence: ${used}` : ""}`;
}

/** Pure: the source a card's research term came from. */
export function cardSource(origin: "scout" | "human", term: string): MapSourceKey {
  const t = term.toLowerCase();
  if (t.startsWith("story:")) return "story";
  if (t.startsWith("options:")) return "options";
  if (t.startsWith("filing:")) return "filings";
  if (t.startsWith("insider+congress:") || t.startsWith("congress:")) return "congress";
  if (t.startsWith("insider:")) return "insider";
  if (t.startsWith("truth:")) return "truth";
  if (t.startsWith("inbox:")) return "inbox";
  if (origin === "human") return "you";
  return "trend";
}

/** Pure: merge (symbol, source, note) facts into nodes, keeping the newest card per stock; most-connected first. */
export function buildNodes(facts: Array<{ symbol: string; source: MapSourceKey; note: string }>, cards: Array<{ id: number; symbol: string; direction: "long" | "short"; status: string; createdAt: string; confidence?: number }>, max = 140): MapNode[] {
  const by = new Map<string, MapNode>();
  const node = (s: string) => by.get(s) ?? (by.set(s, { symbol: s, links: [], cardId: null, direction: null, status: null, confidence: null }), by.get(s)!);
  for (const f of facts) {
    if (!/^[A-Z][A-Z.]{0,5}$/.test(f.symbol)) continue;
    const n = node(f.symbol);
    const same = n.links.find((l) => l.source === f.source);
    if (same) { if (!same.note.includes(f.note) && same.note.length < 400) same.note += `; ${f.note}`; } else n.links.push({ source: f.source, note: f.note });
  }
  for (const c of cards.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const n = by.get(c.symbol);
    if (n) Object.assign(n, { cardId: c.id, direction: c.direction, status: c.status, confidence: c.confidence ?? null });
  }
  return [...by.values()].sort((a, b) => b.links.length - a.links.length || Number(!!b.cardId) - Number(!!a.cardId) || a.symbol.localeCompare(b.symbol)).slice(0, max);
}

export async function ideaMap(now = new Date()): Promise<MapNode[]> {
  const today = toEt(now).date;
  const since30 = addDays(today, -30);
  const [cards, cands, buys, alerts, congress, flags, posts, news, contracts, earnings, movers, social] = await Promise.all([
    store.cardsSince(30), store.candidatesSince(30), store.insiderBuysSince(since30), store.filingAlertsSince(addDays(today, -14)), store.congressTradesSince(since30),
    store.optionsFlagsSince(addDays(today, -7)), store.truthPostsSince(new Date(now.getTime() - 3 * 86400_000).toISOString(), true), newsFeed(now).catch(() => []),
    store.cacheGet<Array<{ ticker: string; amount: number; agency: string }>>("contracts"), store.cacheGet<{ rows: Array<{ symbol: string; date: string; time: string }> }>("earnings"),
    store.cacheGet<{ gainers: Array<{ symbol: string; changePct: number }>; losers: Array<{ symbol: string; changePct: number }> }>("movers"),
    store.cacheGet<{ rows: Array<{ symbol: string; rank: number | null; bullishPct: number | null }> }>("social"),
  ].map((p) => (p as Promise<unknown>).catch(() => null)) as [
    Promise<store.StoredCard[]>, Promise<store.Candidate[]>, Promise<store.InsiderBuyRow[]>, Promise<store.FilingAlert[]>, Promise<store.CongressTradeRow[]>, Promise<store.OptionsFlag[]>, Promise<store.StoredTruth[]>,
    Promise<Awaited<ReturnType<typeof newsFeed>>>, Promise<{ data: Array<{ ticker: string; amount: number; agency: string }> } | null>, Promise<{ data: { rows: Array<{ symbol: string; date: string; time: string }> } } | null>,
    Promise<{ data: { gainers: Array<{ symbol: string; changePct: number }>; losers: Array<{ symbol: string; changePct: number }> } } | null>, Promise<{ data: { rows: Array<{ symbol: string; rank: number | null; bullishPct: number | null }> } } | null>,
  ]);
  const candOf = new Map((cands ?? []).filter((c) => c.cardId !== null).map((c) => [c.cardId!, c]));
  const facts: Array<{ symbol: string; source: MapSourceKey; note: string }> = [];
  for (const c of cards ?? []) {
    const k = candOf.get(c.id);
    const source = cardSource(c.origin, k?.term ?? "");
    facts.push({ symbol: c.primaryTicker, source, note: cardNote(c, source, k?.term ?? c.title, k?.observation ?? null) });
  }
  for (const b of buys ?? []) if (b.symbol && b.routine !== true) facts.push({ symbol: b.symbol, source: "insider", note: `${b.role ?? "insider"} bought $${Math.round((b.value ?? 0) / 1000)}k` });
  for (const a of alerts ?? []) if (a.symbol) facts.push({ symbol: a.symbol, source: "filings", note: a.kind === "13D" ? `new 13D by ${a.filer ?? "?"}` : `8-K ${a.items.map((i) => i.split(" ")[0]).join(", ")}` });
  for (const t of congress ?? []) if (t.tx === "buy" || t.tx === "sell") facts.push({ symbol: t.symbol, source: "congress", note: `${t.member} ${t.tx === "buy" ? "bought" : "sold"}` });
  for (const f of flags ?? []) facts.push({ symbol: f.symbol, source: "options", note: `new ${f.type}s $${f.strike} ${f.expiry.slice(5)}` });
  for (const p of posts ?? []) for (const s of p.read?.tickers ?? []) facts.push({ symbol: s, source: "truth", note: `${p.read!.direction}: ${p.read!.summary.slice(0, 80)}` });
  for (const n of (news ?? []).filter((x) => x.kind === "news" && (x.buzz >= 2 || x.event) && x.symbols.length <= 3)) for (const s of n.symbols) facts.push({ symbol: s, source: "news", note: n.event ?? `${n.buzz} headlines in 6h` });
  for (const r of contracts?.data ?? []) facts.push({ symbol: r.ticker, source: "contracts", note: `$${Math.round(r.amount / 1e6)}M from ${r.agency.slice(0, 30)}` });
  for (const r of earnings?.data.rows ?? []) facts.push({ symbol: r.symbol, source: "earnings", note: `reports ${r.date.slice(5)}${r.time ? ` ${r.time}` : ""}` });
  for (const r of [...(movers?.data.gainers ?? []), ...(movers?.data.losers ?? [])]) facts.push({ symbol: r.symbol, source: "movers", note: `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(1)}% today` });
  for (const r of social?.data.rows ?? []) facts.push({ symbol: r.symbol, source: "stocktwits", note: `trending #${r.rank}${r.bullishPct !== null ? `, ${r.bullishPct}% bullish posts` : ""}` });
  return buildNodes(facts, (cards ?? []).map((c) => ({ id: c.id, symbol: c.primaryTicker, direction: c.direction, status: c.status, createdAt: c.createdAt, confidence: c.card.confidence })));
}
