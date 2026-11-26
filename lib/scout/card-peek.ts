/** Writes the cards named in config/card-peek.ts to the server log, once per revision (see that file for why). */
import { CARD_PEEK } from "@/config/card-peek";
import { cardForApi } from "./card-api";
import { crowdingFor } from "./crowding";
import { etLabel, toEt } from "../time";
import * as store from "./store";

/** Pure: a long text as numbered pieces short enough for one log line each. */
export function logPieces(label: string, text: string, size = 3000): string[] {
  const n = Math.max(1, Math.ceil(text.length / size));
  return Array.from({ length: n }, (_, i) => `${label} [${i + 1}/${n}] ${text.slice(i * size, (i + 1) * size)}`);
}

/** Pure: a card's JSON without the parts that only repeat or decorate (links, chart data), to keep the log short. */
export function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k, v]) => v !== null && v !== "" && !/^(url|urls|links?|chart|logo|html)$/i.test(k)).map(([k, v]) => [k, slim(v)]));
}

const one = (t: string | null | undefined, n: number) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** What the scout did on a stock lately: its cards, the research attempts (with why one was turned away) and the story desk's reads. */
export async function peekSymbols(symbols: string[], days: number, now = new Date()): Promise<string[]> {
  const from = toEt(new Date(now.getTime() - days * 86400_000)).date;
  const [cards, cands, events] = await Promise.all([store.cardsSince(days).catch(() => []), store.candidatesSince(days).catch(() => []), store.storyEventsSince(from).catch(() => [])]);
  const out: string[] = [];
  for (const sym of symbols) {
    const mine = cards.filter((c) => c.primaryTicker === sym || c.card.tickers.some((t) => t.symbol === sym));
    const tried = cands.filter((c) => c.tickersHint.includes(sym) || new RegExp(`\\b${sym}\\b`).test(c.term));
    const read = events.filter((e) => e.symbols.includes(sym));
    out.push(`peek ${sym}: ${mine.length} cards, ${tried.length} research attempts, ${read.length} story-desk reads in ${days} days`);
    // The paper track beside each card, and the stock's recent closes as traded and split-adjusted (a gap between the two is a split).
    for (const c of mine) {
      const t = await store.getTrack(c.id).catch(() => null);
      if (t) out.push(`peek ${sym} track #${c.id}: ${t.direction} ${t.symbol}, card day ${t.cardDate}, entry ${t.entryDate ?? "pending"} @ ${t.entryPrice ?? "?"} (SPY ${t.spyEntry ?? "?"}), exit ${t.exitDate ?? "open"} @ ${t.exitPrice ?? "-"} ${t.exitReason ?? ""}, worst ${t.maxDrawdownPct ?? "?"}%${t.excluded ? `, EXCLUDED: ${t.excluded}` : ""}`);
    }
    try {
      const { marketDataFromEnv } = await import("../alpaca");
      const data = marketDataFromEnv();
      if (data) {
        const today = toEt(now).date, from = toEt(new Date(now.getTime() - 45 * 86400_000)).date;
        const [raw, adj] = await Promise.all([data.getDailyBars([sym], from, today, { feed: "sip", adjustment: "raw" }), data.getDailyBars([sym], from, today, { feed: "sip", adjustment: "all" })]);
        const line = (bars: typeof raw) => bars.filter((b) => b.symbol === sym).sort((a, b) => a.date.localeCompare(b.date)).map((b) => `${b.date.slice(5)} ${b.c}`).join(", ");
        out.push(`peek ${sym} closes as traded: ${line(raw).slice(0, 900)}`);
        out.push(`peek ${sym} closes split-adjusted: ${line(adj).slice(0, 900)}`);
      }
    } catch (e) { out.push(`peek ${sym} closes: ${e instanceof Error ? e.message : String(e)}`); }
    for (const c of mine) out.push(`peek ${sym} card #${c.id} ${etLabel(c.createdAt)} ${c.origin} ${c.direction} ${c.primaryTicker} ${c.status}: ${one(c.title, 140)} | ${one(c.card.thesis, 500)}`);
    for (const c of tried) out.push(`peek ${sym} attempt ${etLabel(c.createdAt)} ${c.origin} "${one(c.term, 100)}" [${c.tickersHint.join(",")}] -> ${c.outcome}${c.cardId ? ` #${c.cardId}` : ""}${c.reason ? `: ${one(c.reason, 600)}` : ""}`);
    for (const e of read) out.push(`peek ${sym} story ${e.etDate} ${e.key} stage ${e.stage} [${e.symbols.join(",")}]: ${one(e.summary, 700)}`);
  }
  return out;
}

/** Each earnings-drift row measured again on the report day: the first numbers and setup against the corrected ones, a line each. */
export async function peekEarningsFixes(): Promise<string[]> {
  const { query } = await import("../db");
  const rows = await query(`SELECT s.symbol, s.report_date::text AS report_date, s.reaction_date::text AS first_day, f.reaction_date::text AS fixed_day, s.setup AS setup0, f.setup AS setup1, s.numbers AS n0, f.numbers AS n1, f.created_at
    FROM earnings_scan_fixes f JOIN earnings_scans s ON s.id = f.scan_id ORDER BY s.report_date DESC, s.symbol LIMIT 80`);
  const v = (n: Record<string, unknown> | null, k: string) => (n && n[k] !== null && n[k] !== undefined ? String(n[k]) : "-");
  const out = [`peek earnings fixes: ${rows.length} rows measured again on the report day; setup changed on ${rows.filter((r) => (r.setup0 ?? null) !== (r.setup1 ?? null)).length}`];
  for (const r of rows) {
    const a = r.n0 as Record<string, unknown> | null, b = r.n1 as Record<string, unknown> | null;
    out.push(`peek earnings fix ${r.symbol} reported ${String(r.report_date).slice(0, 10)}: measured ${String(r.first_day).slice(0, 10)} -> ${String(r.fixed_day).slice(0, 10)}; setup ${r.setup0 ?? "none"} -> ${r.setup1 ?? "none"}; run-up 10d ${v(a, "runup_10d_pct")}% -> ${v(b, "runup_10d_pct")}%; reaction ${v(a, "reaction_pct")}% -> ${v(b, "reaction_pct")}%; volume x${v(a, "volume_ratio")} -> x${v(b, "volume_ratio")}`);
  }
  return out;
}

export async function runCardPeek(origin: string, peek: { rev: number; ids: number[]; symbols?: string[]; days?: number; earningsFixes?: boolean } = CARD_PEEK): Promise<number> {
  if (!peek.ids.length && !peek.symbols?.length && !peek.earningsFixes) return 0;
  const key = `card-peek:${peek.rev}`;
  if (await store.cacheGet(key).catch(() => null)) return 0;
  await store.cachePut(key, { at: new Date().toISOString(), ids: peek.ids });
  let n = 0;
  if (peek.earningsFixes) for (const line of await peekEarningsFixes().catch((e) => [`peek earnings fixes failed: ${e instanceof Error ? e.message : e}`])) { console.log(line); n++; }
  if (peek.symbols?.length) for (const line of await peekSymbols(peek.symbols, peek.days ?? 10)) { console.log(line); n++; }
  for (const id of peek.ids) {
    const card = await store.getCard(id).catch(() => null);
    if (!card) { console.log(`card-peek #${id}: no such card`); continue; }
    const [track, crowd] = await Promise.all([store.getTrack(id).catch(() => null), crowdingFor([id]).then((m) => m.get(id) ?? null).catch(() => null)]);
    for (const line of logPieces(`card-peek #${id}`, JSON.stringify(slim(cardForApi(card, track, crowd, origin))))) console.log(line);
    n++;
  }
  return n;
}
