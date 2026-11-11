/** Polymarket (public Gamma API): odds and one-week odds change for markets matching the term. Free, no key. */
import { getJson } from "../http";
import { dateStr, guarded, type Source } from "./types";

interface Market { question: string; slug?: string; outcomes?: string; outcomePrices?: string; oneDayPriceChange?: number; oneWeekPriceChange?: number; volume24hr?: number; endDate?: string; closed?: boolean }
interface Search { events?: Array<{ title: string; slug: string; markets?: Market[] }> }

const parse = (s?: string): string[] => { try { return s ? (JSON.parse(s) as string[]) : []; } catch { return []; } };

/** Pure: the yes-odds and weekly change of a market, as points (0–100). */
export function marketOdds(m: Market) {
  const prices = parse(m.outcomePrices).map(Number);
  const outcomes = parse(m.outcomes);
  const i = Math.max(0, outcomes.findIndex((o) => o.toLowerCase() === "yes"));
  const yes = prices[i];
  if (!Number.isFinite(yes)) return null;
  return { yes: Math.round(yes * 100), weekChange: m.oneWeekPriceChange === undefined ? null : Math.round(m.oneWeekPriceChange * 100), dayChange: m.oneDayPriceChange === undefined ? null : Math.round(m.oneDayPriceChange * 100) };
}

export const polymarket: Source = {
  id: "polymarket",
  label: "Polymarket",
  about: "Odds and odds changes for events with identifiable listed winners or losers.",
  configured: () => true,
  probe: (ctx) =>
    guarded("polymarket", async () => {
      const r = await getJson<Search>(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(ctx.term)}&limit_per_type=5&events_status=active`, { fetchImpl: ctx.fetchImpl });
      const markets = (r.events ?? []).flatMap((e) => (e.markets ?? []).filter((m) => !m.closed).map((m) => ({ event: e.title, slug: e.slug, ...m })));
      const signals = markets
        .map((m) => ({ m, o: marketOdds(m) }))
        .filter((x) => x.o)
        .sort((a, b) => Math.abs(b.o!.weekChange ?? 0) - Math.abs(a.o!.weekChange ?? 0))
        .slice(0, 3)
        .map(({ m, o }) => ({
          source: "polymarket", metric: "yes_odds_points", value: o!.yes, baseline: o!.weekChange === null ? null : o!.yes - o!.weekChange,
          changeVs12m: null, asOf: dateStr(ctx.now),
          note: `"${m.question}": ${o!.yes}% yes${o!.weekChange === null ? "" : ` (${o!.weekChange >= 0 ? "+" : ""}${o!.weekChange} pts in 7 days)`}${m.endDate ? `, resolves ${m.endDate.slice(0, 10)}` : ""}`,
          detail: { event: m.event, url: `https://polymarket.com/event/${m.slug}`, week_change_points: o!.weekChange, day_change_points: o!.dayChange, volume_24h: m.volume24hr, end_date: m.endDate?.slice(0, 10) },
        }));
      return { source: "polymarket", status: "ok", detail: signals.length ? undefined : `no open market matches "${ctx.term}"`, signals };
    }),
};
