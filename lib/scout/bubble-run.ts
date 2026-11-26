/**
 * The parabolic-mover pass of Bubbles (see bubble-movers.ts for the measures). Candidates: the theme baskets, the
 * hype stories the news read found, Stocktwits trending and the day's biggest gainers. One bar request for all of
 * them, attention (Stocktwits) for the 20 most stretched, then one row per hype run ("episode") that stays open while
 * the stock is building or in mania, and the theme summary for the page. After a run is first listed, the stock's
 * move 10 and 20 sessions later against SPY is filled in, so the tab shows how hype runs actually ended.
 */
import { plainUsSymbol, unitWarrantRight } from "./company-match";
import type { DailyBar } from "../alpaca";
import { query as q } from "../db";
import { addDays, toEt } from "../time";
import { hypeLevel, parabola, PARABOLA, themeState, THEME_BASKETS, type HypeLevel, type Parabola } from "./bubble-movers";
import type { HypeStory } from "./bubbles";
import type { ResearchDeps } from "./research";
import * as store from "./store";

export const MOVERS = { attention: 20, maxSymbols: 110, gapDays: 10 };

export interface ThemeSummary { theme: string; level: HypeLevel; hot: number; median30: number | null; members: Array<{ symbol: string; run30: number | null; sigmas30: number | null; level: HypeLevel }>; why: string | null; url: string | null; fromNews: boolean }
export interface MoverRow {
  id: number; symbol: string; theme: string | null; why: string | null; url: string | null; source: string | null; firstSeen: string; lastSeen: string;
  levelFirst: HypeLevel; level: HypeLevel; priceFirst: number | null; priceLast: number | null; peakPrice: number | null;
  run5: number | null; run30: number | null; ext50: number | null; volRatio: number | null; sigmas30: number | null; accel: number | null; perHour: number | null; z: number | null;
  spyFirst: number | null; priceAfter10: number | null; priceAfter20: number | null; spyAfter20: number | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const toMover = (r: Record<string, unknown>): MoverRow => ({
  id: Number(r.id), symbol: String(r.symbol), theme: (r.theme as string) ?? null, why: (r.why as string) ?? null, url: (r.url as string) ?? null, source: (r.source as string) ?? null,
  firstSeen: new Date(r.first_seen as string).toISOString(), lastSeen: new Date(r.last_seen as string).toISOString(), levelFirst: r.level_first as HypeLevel, level: r.level as HypeLevel,
  priceFirst: num(r.price_first), priceLast: num(r.price_last), peakPrice: num(r.peak_price), run5: num(r.run5), run30: num(r.run30), ext50: num(r.ext50), volRatio: num(r.vol_ratio), sigmas30: num(r.sigmas30), accel: num(r.accel), perHour: num(r.per_hour), z: num(r.z),
  spyFirst: num(r.spy_first), priceAfter10: num(r.price_after10), priceAfter20: num(r.price_after20), spyAfter20: num(r.spy_after20),
});

export async function moverRows(days = 120): Promise<MoverRow[]> {
  // Rows listed from the gainers or trending lists before units, warrants and foreign listings were kept out are not shown.
  return (await q(`SELECT * FROM bubble_movers WHERE last_seen > now() - ($1::int * interval '1 day') ORDER BY last_seen DESC`, [days])).map(toMover)
    .filter((r) => !/top gainers|trending/i.test(r.source ?? "") || (plainUsSymbol(r.symbol) && !unitWarrantRight(r.symbol)));
}

export async function themeSummary(): Promise<{ data: ThemeSummary[]; updatedAt: string } | null> {
  return store.cacheGet<ThemeSummary[]>("bubbles:themes").catch(() => null);
}

/** Pure: the move from first listing to `after` against SPY over the same days (percent), or null. */
export function moverOutcome(r: Pick<MoverRow, "priceFirst" | "spyFirst">, after: number | null, spyAfter: number | null): number | null {
  if (!r.priceFirst || !after) return null;
  const s = after / r.priceFirst - 1, m = r.spyFirst && spyAfter ? spyAfter / r.spyFirst - 1 : 0;
  return Math.round((s - m) * 1000) / 10;
}

export async function runMovers(deps: ResearchDeps, hype: HypeStory[], trending: string[], spy: DailyBar[]): Promise<string> {
  const data = deps.data!;
  const today = toEt(deps.now).date;
  // Where each symbol comes from (a theme name and why, when known).
  const tag = new Map<string, { theme: string | null; why: string | null; url: string | null; source: string }>();
  for (const [theme, syms] of Object.entries(THEME_BASKETS)) for (const s of syms) tag.set(s, { theme, why: null, url: null, source: "theme basket" });
  for (const h of hype) for (const s of h.tickers) tag.set(s, { theme: h.theme, why: h.why, url: h.url, source: h.source });
  // Trending and top-gainer lists carry foreign listings and SPAC units, warrants and rights: only US common stocks and funds go on.
  const { commonStocksOnly } = await import("./company-match");
  const nameOf = data.getAsset ? (sym: string) => data.getAsset!(sym).then((a) => a?.name ?? null) : null;
  for (const s of await commonStocksOnly(trending, nameOf)) if (!tag.has(s)) tag.set(s, { theme: null, why: null, url: null, source: "Stocktwits trending" });
  const gainers = data.getMovers ? await commonStocksOnly((await data.getMovers(25).catch(() => ({ gainers: [] }))).gainers.filter((g) => g.price >= PARABOLA.minPrice).map((g) => g.symbol), nameOf) : [];
  for (const s of gainers) if (!tag.has(s)) tag.set(s, { theme: null, why: null, url: null, source: "top gainers" });
  const symbols = [...tag.keys()].slice(0, MOVERS.maxSymbols);

  const bars = await data.getDailyBars(symbols, addDays(today, -200), today).catch(() => [] as DailyBar[]);
  const by = new Map<string, DailyBar[]>();
  for (const b of bars) by.set(b.symbol, [...(by.get(b.symbol) ?? []), b]);
  const shape = new Map<string, Parabola>();
  for (const s of symbols) { const p = parabola(by.get(s) ?? []); if (p && p.price >= PARABOLA.minPrice) shape.set(s, p); }

  // Attention for the most stretched (Stocktwits is rate-limited).
  const { measureAttention } = await import("./crowding");
  const loudest = [...shape.entries()].filter(([, p]) => p.run30 > 0 && (p.sigmas30 ?? 0) >= PARABOLA.sigmaBuilding).sort((a, b) => (b[1].sigmas30 ?? 0) - (a[1].sigmas30 ?? 0)).slice(0, MOVERS.attention);
  const attention = new Map<string, { perHour: number; z: number | null }>();
  for (const [s] of loudest) { const a = await measureAttention(s, deps.now, deps.fetchImpl, false).catch(() => null); if (a) attention.set(s, { perHour: a.perHour, z: a.z }); }

  const level = new Map<string, HypeLevel>();
  for (const [s, p] of shape) level.set(s, hypeLevel(p, { z: attention.get(s)?.z ?? null, stage: null }));

  // Themes: the baskets, plus the news's hype stories as their own themes.
  const themes: ThemeSummary[] = [];
  const addTheme = (theme: string, syms: string[], why: string | null, url: string | null, fromNews: boolean) => {
    const members = syms.filter((s) => shape.has(s)).map((s) => ({ symbol: s, run30: shape.get(s)!.run30, sigmas30: shape.get(s)!.sigmas30, level: level.get(s) ?? "quiet" as HypeLevel }));
    if (!members.length) return;
    const st = themeState(members);
    themes.push({ theme, level: st.level, hot: st.hot, median30: st.median30, members: members.sort((a, b) => (b.run30 ?? 0) - (a.run30 ?? 0)), why, url, fromNews });
  };
  for (const [t, syms] of Object.entries(THEME_BASKETS)) addTheme(t, syms, null, null, false);
  for (const h of hype) if (!THEME_BASKETS[h.theme]) addTheme(h.theme, h.tickers, h.why, h.url, true);
  const order = { mania: 0, building: 1, quiet: 2 } as const;
  themes.sort((a, b) => order[a.level] - order[b.level] || (b.median30 ?? 0) - (a.median30 ?? 0));
  await store.cachePut("bubbles:themes", themes).catch(() => undefined);

  // One row per hype run: continue the open one (seen in the last 10 days) or start a new one.
  const spyNow = spy.length ? spy[spy.length - 1].c : null;
  let listed = 0;
  for (const [s, p] of shape) {
    const lv = level.get(s)!;
    if (lv === "quiet") continue;
    const t = tag.get(s)!, a = attention.get(s);
    const open = (await q(`SELECT id, peak_price FROM bubble_movers WHERE symbol = $1 AND last_seen > now() - ($2::int * interval '1 day') ORDER BY id DESC LIMIT 1`, [s, MOVERS.gapDays]))[0];
    if (open) {
      await q(`UPDATE bubble_movers SET last_seen = now(), level = $2, price_last = $3, peak_price = GREATEST(coalesce(peak_price, 0), $3), run5 = $4, run30 = $5, ext50 = $6, vol_ratio = $7, sigmas30 = $8, accel = $9, per_hour = coalesce($10, per_hour), z = coalesce($11, z), theme = coalesce(theme, $12), why = coalesce(why, $13), url = coalesce(url, $14) WHERE id = $1`,
        [open.id, lv, p.price, p.run5, p.run30, p.ext50, p.volRatio, p.sigmas30, p.accel, a?.perHour ?? null, a?.z ?? null, t.theme, t.why, t.url]);
    } else {
      await q(`INSERT INTO bubble_movers (symbol, theme, why, url, source, level_first, level, price_first, price_last, peak_price, run5, run30, ext50, vol_ratio, sigmas30, accel, per_hour, z, spy_first) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [s, t.theme, t.why, t.url, t.source, lv, p.price, p.run5, p.run30, p.ext50, p.volRatio, p.sigmas30, p.accel, a?.perHour ?? null, a?.z ?? null, spyNow]);
    }
    listed++;
  }

  // What happened after: 10 and 20 sessions from the day a run was first listed, against SPY (filled once).
  const due = (await q(`SELECT * FROM bubble_movers WHERE price_after20 IS NULL AND first_seen < now() - interval '14 days' AND first_seen > now() - interval '120 days' LIMIT 40`)).map(toMover);
  for (const r of due) {
    const day = toEt(new Date(r.firstSeen)).date;
    const b = await data.getDailyBars([r.symbol, "SPY"], day, addDays(day, 40)).catch(() => [] as DailyBar[]);
    const mine = b.filter((x) => x.symbol === r.symbol && x.date > day).sort((x, y) => x.date.localeCompare(y.date));
    const sp = b.filter((x) => x.symbol === "SPY" && x.date > day).sort((x, y) => x.date.localeCompare(y.date));
    const a10 = mine[9]?.c ?? null, a20 = mine[19]?.c ?? null, s20 = sp[19]?.c ?? null;
    if (a10 === null) continue;
    await q(`UPDATE bubble_movers SET price_after10 = $2, price_after20 = $3, spy_after20 = $4 WHERE id = $1`, [r.id, a10, a20, s20]);
  }
  return `movers: ${symbols.length} checked, ${listed} building or in mania, ${themes.filter((t) => t.level !== "quiet").length} hot themes`;
}
