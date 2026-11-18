/**
 * Live data attached to a chat question about a stock: the price now, recent moves and the last week's headlines,
 * fetched when the question is asked (the chat's briefing is a snapshot from when the chat started, and can be days old).
 */
import type { DailyBar, MarketData, NewsItem } from "../alpaca";
import { addDays, fmtEt, toEt } from "../time";

/** Pure: card numbers a message names ("#208", "card 208", "cards #177 and #197"), at most 3. */
export function cardRefs(text: string, max = 3): number[] {
  const ids = [...text.matchAll(/(?:\bcards?\s*#?\s*|#)(\d{1,6})\b/gi)].map((m) => Number(m[1])).filter((n) => n > 0);
  return [...new Set(ids)].slice(0, max);
}

/** Everyday words that are also tickers: not taken as a stock when typed in lower case. */
const COMMON = new Set("a i am an and are as at be big but by can do for go has he her him his how if in is it its key low me my new no not now of on one or our out own see she so the to two up us was we what who why will with you all any are buy day did get got had has let may net off old per put run sell set top try use way well yes year also back been best both call come does down each even ever fast from give good have here high just keep last like long look made make many more most much must near next only open over part play plan real rest same says show some such sure take tell than that them then they this time very want were when will with work your card cards stock stocks price news idea ideas trade trades deal info data cost rate live life love home safe team wish hope fun joy peak true real cash earn earns beat beats miss gap gaps bull bear bulls bears call calls puts move moves week month today next past cut cuts low lows high highs buy sell hold fast slow big main nice cool hot gold oil bond rally dump pump moon".split(" "));

/** Pure: the tickers a typed question names: $NVDA or NVDA in any case, if listed; everyday words only in capitals. */
export function tickersAsked(text: string, listed: Set<string>, max = 4): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\$)?\b([A-Za-z]{2,5}(?:\.[A-Za-z])?)\b/g)) {
    const raw = m[2], sym = raw.toUpperCase();
    if (!listed.has(sym) || out.includes(sym)) continue;
    const typedAsTicker = !!m[1] || raw === sym;
    if (!typedAsTicker && COMMON.has(raw.toLowerCase())) continue;
    if (raw === sym && COMMON.has(raw.toLowerCase()) && raw.length <= 2) continue; // "AM", "IT" in capitals: still too ambiguous
    out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`);

/** Pure: % move from the close at or before `days` sessions back to the latest close. */
export function moveOver(bars: DailyBar[], sessions: number): number | null {
  const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (s.length < 2) return null;
  const from = s[Math.max(0, s.length - 1 - sessions)].c;
  return from > 0 ? (s[s.length - 1].c / from - 1) * 100 : null;
}

/** Pure: the stock's normal daily move: the average absolute close-to-close change over the last `n` sessions, in %. */
export function avgDailyMove(bars: DailyBar[], n = 20): number | null {
  const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-(n + 1));
  if (s.length < 6) return null;
  const moves = s.slice(1).map((b, i) => Math.abs(b.c / s[i].c - 1) * 100);
  return moves.reduce((a, b) => a + b, 0) / moves.length;
}

/** Pure: the live block for one stock. */
export function liveLines(symbol: string, snap: { price: number; prevClose: number | null; at: string | null } | undefined, bars: DailyBar[], news: NewsItem[]): string {
  const lines: string[] = [];
  if (snap?.price) {
    const day = snap.prevClose ? (snap.price / snap.prevClose - 1) * 100 : null;
    lines.push(`${symbol} price $${snap.price.toFixed(snap.price < 1 ? 4 : 2)}${day !== null ? ` (${pct(day)} vs the previous close)` : ""}${snap.at ? `, last trade ${fmtEt(snap.at)} ET` : ""}.`);
  } else if (bars.length) {
    const last = bars.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
    lines.push(`${symbol} last close $${last.c.toFixed(2)} on ${last.date} (no live quote).`);
  } else lines.push(`${symbol}: no price data.`);
  if (bars.length > 5) {
    const normal = avgDailyMove(bars);
    lines.push(`Moves: ${pct(moveOver(bars, 5))} over 5 sessions, ${pct(moveOver(bars, 21))} over 1 month, ${pct(moveOver(bars, 63))} over 3 months.${normal !== null ? ` Normal daily move: about ${normal.toFixed(1)}% (average over 20 sessions).` : ""}`);
  }
  const mine = news.filter((n) => n.symbols.includes(symbol)).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 12);
  lines.push(mine.length ? `Headlines, last 7 days (newest first):\n${mine.map((n) => `- ${fmtEt(n.ts)} ET [${n.source || "news"}] ${n.headline}${n.repostedAt ? " (re-posted older news)" : ""}`).join("\n")}` : "No headlines in the last 7 days.");
  return lines.join("\n");
}

/** The live block for up to 4 stocks, or null when there is no market data. */
export async function liveContext(data: MarketData | null, symbols: string[], now = new Date()): Promise<string | null> {
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, 4);
  if (!data || !syms.length) return null;
  const today = toEt(now).date;
  const [snaps, bars, news] = await Promise.all([
    data.getSnapshots?.(syms).catch(() => ({})) ?? Promise.resolve({}),
    data.getDailyBars(syms, addDays(today, -130), today).catch(() => [] as DailyBar[]),
    data.getNews(syms, new Date(now.getTime() - 7 * 86400_000), now, 80).catch(() => [] as NewsItem[]),
  ]);
  const blocks = syms.map((s) => liveLines(s, (snaps as Record<string, { price: number; prevClose: number | null; at: string | null }>)[s], bars.filter((b) => b.symbol === s), news));
  return `LIVE DATA fetched ${fmtEt(now.toISOString())} ET, newer than the briefing. Use it for the current price, recent moves and recent news, and say when the briefing's figures are out of date.\n${blocks.join("\n\n")}`;
}
