/**
 * Crowding score (0–100) and stage (0–4) per card, from "Finding ideas before the crowd": attention arrives late,
 * so a card is "early" while the crowd is not there yet and "late" once it is, however true the story.
 *
 * Parts (each scaled 0–100; the score is their average, with at least two present):
 * - attention: Stocktwits messages per hour against the stock's own baseline (log z-score), kept apart from
 *   the bullish/bearish share, which is shown but not scored;
 * - news: mainstream stories in 30 days against the stock's usual 30 days;
 * - search: Google Trends, the last 4 weeks against 12 months;
 * - extension: how far the price is above its 200-day average;
 * - price ahead of news: a big 30-day run while news is no busier than usual.
 * Stage: 0 stealth, 1 recognition, 2 institutional adoption, 3 retail/media mania, 4 crowded unwind (the report's table).
 *
 * Rules of thumb from the report, not a tested model: the scoreboard splits results by stage and score at entry so
 * our own paper results say whether it helps. Each card records its score when written (never back-filled for older
 * cards); open cards are measured each weekday, and an attention jump of 3σ+ during a big run sends a paper "trim"
 * alert. Nothing here changes a track: the alert says what the signal shows.
 */
import type { DailyBar, MarketData } from "../alpaca";
import { query as q } from "../db";
import { getJson } from "../http";
import { coverage as newsCoverage } from "../sources/news";
import { messageRate, ST_HOST, ST_UA, type StMessage } from "../sources/stocktwits";
import { addDays, toEt } from "../time";
import { spikeScore } from "./chatter";
import { moveSince } from "./lateness";
import * as store from "./store";

export const CROWDING = { minBaselineDays: 10, lookbackDays: 90, trimZ: 3, trimRun30: 25, trimRun5: 12, batch: 12, trendsPerRun: 2 };

export interface CrowdingParts {
  attention: { perHour: number; baseline: number | null; z: number | null; days: number; bullishShare: number | null } | null;
  news: { stories30d: number; baseline30d: number | null; ratio: number | null } | null;
  search: { v4: number; v52: number; ratio: number | null } | null;
  extension: { close: number; sma200: number; pctAbove: number } | null;
  run: { move30: number | null; move5: number | null; offHigh20: number | null } | null;
  coverage: { analysts: number | null; band: string | null } | null;
}

export const STAGE_LABEL = ["stealth", "recognition", "institutional adoption", "retail / media mania", "crowded unwind"] as const;

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const log2 = (x: number) => Math.log(Math.max(x, 0.01)) / Math.LN2;

/** Pure: each part scaled to 0–100 (missing parts left out). */
export function components(p: CrowdingParts): Record<string, number> {
  const out: Record<string, number> = {};
  if (p.attention?.z !== null && p.attention?.z !== undefined) out.attention = clamp(((p.attention.z + 1) / 5) * 100);
  if (p.news?.ratio !== null && p.news?.ratio !== undefined) out.news = clamp(((log2(p.news.ratio) + 1) / 3) * 100);
  if (p.search?.ratio !== null && p.search?.ratio !== undefined) out.search = clamp(((log2(p.search.ratio) + 1) / 3) * 100);
  if (p.extension) out.extension = clamp(((p.extension.pctAbove + 10) / 70) * 100);
  if (p.run?.move30 !== null && p.run?.move30 !== undefined) {
    const run = clamp((Math.abs(p.run.move30) / 50) * 100);
    // The late-stage tell: price outrunning the news (a big move without a matching rise in coverage).
    const quiet = p.news?.ratio === null || p.news?.ratio === undefined ? null : p.news.ratio <= 1.2;
    out.priceAheadOfNews = quiet === null ? Math.round(run / 2) : quiet ? run : Math.round(run / 2);
  }
  return out;
}

/** Pure: score (average of the parts, needs two) and stage. */
export function crowdingScore(p: CrowdingParts): { score: number | null; stage: number | null; parts: Record<string, number> } {
  const parts = components(p);
  const vals = Object.values(parts);
  if (vals.length < 2) return { score: null, stage: null, parts };
  const score = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  const z = p.attention?.z ?? null;
  const move30 = p.run?.move30 ?? 0;
  const off = p.run?.offHigh20 ?? 0;
  const stage = score >= 55 && off <= -12 ? 4 : score >= 65 || (z !== null && z >= CROWDING.trimZ && Math.abs(move30) >= CROWDING.trimRun30) ? 3 : score >= 45 ? 2 : score >= 25 ? 1 : 0;
  return { score, stage, parts };
}

/** Pure: early (stage 0–1, the report's best entries), middle (2) or late (3–4). */
export const timing = (stage: number | null): "early" | "middle" | "late" | null => (stage === null ? null : stage <= 1 ? "early" : stage === 2 ? "middle" : "late");

/** Pure: the paper trim (or cover) signal on an open card: attention 3σ+ during a big run in the card's direction. */
export function trimSignal(p: CrowdingParts, direction: "long" | "short"): string | null {
  const z = p.attention?.z;
  const m30 = p.run?.move30 ?? null, m5 = p.run?.move5 ?? null;
  if (z === null || z === undefined || z < CROWDING.trimZ) return null;
  const sign = direction === "long" ? 1 : -1;
  const ran = (m30 !== null && sign * m30 >= CROWDING.trimRun30) || (m5 !== null && sign * m5 >= CROWDING.trimRun5);
  if (!ran) return null;
  return `${direction === "long" ? "Trim" : "Cover"} signal (paper): Stocktwits attention ${z.toFixed(1)}σ above its baseline during a ${m30 !== null ? `${m30 > 0 ? "+" : ""}${m30}% move in 30 days` : `${m5! > 0 ? "+" : ""}${m5}% move in 5 days`}: the crowd arriving, the report's ${direction === "long" ? "trim/exit" : "cover"} tell.`;
}

/** Pure: price parts from daily bars (oldest first or any order). */
export function priceParts(bars: DailyBar[], today: string): { extension: CrowdingParts["extension"]; run: CrowdingParts["run"] } {
  const b = bars.slice().sort((x, y) => x.date.localeCompare(y.date));
  if (b.length < 25) return { extension: null, run: null };
  const close = b[b.length - 1].c;
  const sma = b.length >= 200 ? b.slice(-200).reduce((a, x) => a + x.c, 0) / 200 : null;
  const high20 = Math.max(...b.slice(-20).map((x) => x.h));
  return {
    extension: sma ? { close, sma200: Math.round(sma * 100) / 100, pctAbove: Math.round((close / sma - 1) * 1000) / 10 } : null,
    run: { move30: moveSince(b, addDays(today, -30)), move5: moveSince(b, addDays(today, -7)), offHigh20: high20 > 0 ? Math.round((close / high20 - 1) * 1000) / 10 : null },
  };
}

// ---------------------------------------------------------------- measuring

/** Attention now, against the stock's own history (this log plus the chatter test's, 90 days). Saves today's reading. */
export async function measureAttention(symbol: string, now: Date, fetchImpl?: typeof fetch, save = true): Promise<CrowdingParts["attention"]> {
  const et = toEt(now).date;
  const stream = await getJson<{ symbol?: { watchlist_count?: number }; messages?: StMessage[] }>(`${ST_HOST}/streams/symbol/${encodeURIComponent(symbol)}.json?limit=30`, { headers: ST_UA, minIntervalMs: 1500, fetchImpl, cacheMs: 0, retries: 1 });
  const rate = messageRate(stream.messages ?? [], now);
  if (!rate) return null;
  if (save) await q(`INSERT INTO card_attention (date, symbol, per_hour, bullish_share, watchers, sampled) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (date, symbol) DO NOTHING`, [et, symbol, rate.perHour, rate.bullishShare, stream.symbol?.watchlist_count ?? null, (stream.messages ?? []).length]);
  const from = addDays(et, -CROWDING.lookbackDays);
  const hist = await q(
    `SELECT date, per_hour FROM card_attention WHERE symbol = $1 AND date >= $2 AND date < $3
     UNION SELECT date, per_hour FROM chatter_daily WHERE symbol = $1 AND date >= $2 AND date < $3 ORDER BY date`, [symbol, from, et]).catch(() => []);
  const byDay = new Map(hist.map((r) => [String(r.date).slice(0, 10), Number(r.per_hour)]));
  const history = [...byDay.values()];
  const sc = spikeScore(history, rate.perHour, { log: true, minHistory: CROWDING.minBaselineDays, lookback: CROWDING.lookbackDays });
  return { perHour: rate.perHour, baseline: sc ? Math.round(sc.baseline * 100) / 100 : null, z: sc ? Math.round(sc.z * 100) / 100 : null, days: history.length, bullishShare: rate.bullishShare };
}

async function searchPart(symbol: string, fetchImpl?: typeof fetch, allowFetch = true): Promise<CrowdingParts["search"]> {
  const key = `trends:${symbol}`;
  const cached = await store.cacheGet<CrowdingParts["search"]>(key).catch(() => null);
  if (cached && Date.now() - Date.parse(cached.updatedAt) < 7 * 86400_000) return cached.data;
  if (!allowFetch) return cached?.data ?? null;
  const info = (await store.symbolInfo([symbol]).catch(() => new Map())).get(symbol) as { name?: string | null } | undefined;
  const term = (info?.name ?? "").replace(/\b(inc|corp|corporation|co|ltd|plc|holdings?|group|class [a-z]|common stock|ordinary shares)\b\.?/gi, "").replace(/[,.]+/g, " ").replace(/\s+/g, " ").trim() || `${symbol} stock`;
  try {
    const { interestOverTime, interestSummary } = await import("../sources/googletrends");
    const s = interestSummary(await interestOverTime(term, fetchImpl));
    const out = s ? { v4: s.v4, v52: s.v52, ratio: s.v52 > 0 ? Math.round((s.v4 / s.v52) * 100) / 100 : null } : null;
    await store.cachePut(key, out);
    return out;
  } catch {
    return cached?.data ?? null; // Google rate-limits hard: a miss leaves the part out
  }
}

async function newsPart(data: MarketData, symbol: string, now: Date): Promise<CrowdingParts["news"]> {
  const items = await data.getNews([symbol], new Date(now.getTime() - 30 * 86400_000), now, 300);
  const before = await data.getNews([symbol], new Date(now.getTime() - 120 * 86400_000), new Date(now.getTime() - 30 * 86400_000), 1000);
  const stories30d = newsCoverage(items).mainstream;
  const baseline30d = Math.round((newsCoverage(before).mainstream / 3) * 10) / 10;
  return { stories30d, baseline30d, ratio: baseline30d > 0 ? Math.round(((stories30d + 0.5) / (baseline30d + 0.5)) * 100) / 100 : stories30d > 0 ? 3 : 1 };
}

/** Every part for a stock now (each part best effort). */
export async function measureCrowding(symbol: string, data: MarketData | null, now: Date, opts: { fetchImpl?: typeof fetch; trends?: boolean; saveAttention?: boolean } = {}): Promise<CrowdingParts> {
  const today = toEt(now).date;
  const safe = async <T,>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
  const [attention, news, search, bars, cov] = await Promise.all([
    safe(() => measureAttention(symbol, now, opts.fetchImpl, opts.saveAttention ?? true)),
    data ? safe(() => newsPart(data, symbol, now)) : Promise.resolve(null),
    safe(() => searchPart(symbol, opts.fetchImpl, opts.trends ?? false)),
    data ? safe(() => data.getDailyBars([symbol], addDays(today, -300), today)) : Promise.resolve(null),
    safe(() => import("../sources/coverage").then(({ coverageOf }) => coverageOf([symbol]))),
  ]);
  const price = bars ? priceParts(bars.filter((b) => b.symbol === symbol), today) : { extension: null, run: null };
  const c = cov?.get(symbol);
  return { attention, news, search, extension: price.extension, run: price.run, coverage: c ? { analysts: c.analysts, band: c.band } : null };
}

export interface CrowdingRow { cardId: number; symbol: string; kind: "entry" | "daily"; measuredOn: string; score: number | null; stage: number | null; parts: CrowdingParts & { scaled?: Record<string, number> } }

const toRow = (r: Record<string, unknown>): CrowdingRow => ({ cardId: Number(r.card_id), symbol: String(r.symbol), kind: r.kind as "entry" | "daily", measuredOn: String(r.measured_on).slice(0, 10), score: r.score === null ? null : Number(r.score), stage: r.stage === null ? null : Number(r.stage), parts: r.parts as CrowdingRow["parts"] });

async function saveRow(cardId: number, symbol: string, kind: "entry" | "daily", now: Date, p: CrowdingParts): Promise<CrowdingRow> {
  const s = crowdingScore(p);
  await q(`INSERT INTO card_crowding (card_id, symbol, kind, measured_on, score, stage, parts) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (card_id, kind, measured_on) DO NOTHING`, [cardId, symbol, kind, toEt(now).date, s.score, s.stage, JSON.stringify({ ...p, scaled: s.parts })]);
  return { cardId, symbol, kind, measuredOn: toEt(now).date, score: s.score, stage: s.stage, parts: { ...p, scaled: s.parts } };
}

/** When a card is written: its crowding at entry (never back-filled later). Never throws. */
export async function recordEntryCrowding(cardId: number, symbol: string, data: MarketData | null, now: Date, fetchImpl?: typeof fetch): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = await Promise.race([measureCrowding(symbol, data, now, { fetchImpl, trends: true }), new Promise<null>((r) => { timer = setTimeout(() => r(null), 25_000); })]).finally(() => clearTimeout(timer));
    if (p) await saveRow(cardId, symbol, "entry", now, p);
  } catch {
    /* crowding is extra: research never fails on it */
  }
}

/** The entry and latest daily readings per card. */
export async function crowdingFor(cardIds: number[]): Promise<Map<number, { entry: CrowdingRow | null; latest: CrowdingRow | null }>> {
  const out = new Map<number, { entry: CrowdingRow | null; latest: CrowdingRow | null }>();
  if (!cardIds.length) return out;
  const rows = (await q(`SELECT DISTINCT ON (card_id, kind) * FROM card_crowding WHERE card_id = ANY($1::int[]) ORDER BY card_id, kind, measured_on DESC`, [cardIds]).catch(() => [])).map(toRow);
  for (const r of rows) {
    const cur = out.get(r.cardId) ?? { entry: null, latest: null };
    if (r.kind === "entry") cur.entry = r; else cur.latest = r;
    out.set(r.cardId, cur);
  }
  return out;
}

/** The latest reading for a stock (any card), for research and the chat. */
export async function latestCrowding(symbol: string): Promise<CrowdingRow | null> {
  return (await q(`SELECT * FROM card_crowding WHERE symbol = $1 ORDER BY measured_on DESC, id DESC LIMIT 1`, [symbol]).catch(() => [])).map(toRow)[0] ?? null;
}

/** Pure: one line for a reading. */
export function crowdingLine(r: Pick<CrowdingRow, "score" | "stage" | "measuredOn" | "parts">): string {
  const p = r.parts;
  const bits = [
    p.attention ? `Stocktwits ${p.attention.perHour}/h${p.attention.z !== null ? ` (${p.attention.z > 0 ? "+" : ""}${p.attention.z}σ vs baseline)` : ` (baseline building: ${p.attention.days} days)`}${p.attention.bullishShare !== null ? `, ${Math.round(p.attention.bullishShare * 100)}% bullish` : ""}` : null,
    p.news ? `news ${p.news.stories30d} stories/30d vs usual ${p.news.baseline30d ?? "?"}` : null,
    p.search?.ratio !== null && p.search?.ratio !== undefined ? `Google searches ×${p.search.ratio} vs 12 months` : null,
    p.extension ? `${p.extension.pctAbove > 0 ? "+" : ""}${p.extension.pctAbove}% vs 200-day average` : null,
    p.run?.move30 !== null && p.run?.move30 !== undefined ? `${p.run.move30 > 0 ? "+" : ""}${p.run.move30}% in 30 days` : null,
    p.coverage?.analysts !== null && p.coverage?.analysts !== undefined ? `${p.coverage.analysts} analysts (${p.coverage.band} coverage)` : null,
  ].filter(Boolean);
  return `${r.score === null ? "crowding not scored (too few parts)" : `crowding ${r.score}/100, stage ${r.stage} (${STAGE_LABEL[r.stage!]}, ${timing(r.stage)})`} on ${r.measuredOn}${bits.length ? `: ${bits.join("; ")}` : ""}`;
}

/** Each weekday: open cards' stocks measured (a batch per run), a daily row per open card, and the paper trim alerts. */
export async function runCrowdingBatch(data: MarketData | null, now: Date, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<string> {
  const et = toEt(now);
  const dow = new Date(`${et.date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return "crowding: weekend";
  const tracks = (await store.allTracks()).filter((t) => !t.exitDate && !t.invalidatedAt && !t.excluded);
  const bySym = new Map<string, typeof tracks>();
  for (const t of tracks) bySym.set(t.symbol, [...(bySym.get(t.symbol) ?? []), t]);
  const done = new Set((await q(`SELECT DISTINCT symbol FROM card_crowding WHERE kind = 'daily' AND measured_on = $1`, [et.date])).map((r) => String(r.symbol)));
  const todo = [...bySym.keys()].filter((s) => !done.has(s));
  // Coverage for the open cards' stocks first (cheap, weekly per stock).
  await import("../sources/coverage").then(({ refreshCoverage }) => refreshCoverage([...bySym.keys()], env, 15, fetchImpl)).catch(() => 0);
  let measured = 0, trends = 0;
  const alerts: string[] = [];
  for (const sym of todo.slice(0, CROWDING.batch)) {
    const p = await measureCrowding(sym, data, now, { fetchImpl, trends: trends < CROWDING.trendsPerRun });
    if (p.search) trends++;
    measured++;
    for (const t of bySym.get(sym)!) {
      await saveRow(t.cardId, sym, "daily", now, p);
      const sig = trimSignal(p, t.direction);
      if (sig && (await store.claimNotification(`trim:${t.cardId}:${et.date.slice(0, 7)}`, `${sym} ${t.direction} trim signal`))) {
        alerts.push(`#${t.cardId} ${sym}`);
        const { pushConfigured, sendPush } = await import("../notify");
        const base = env.DASHBOARD_URL?.replace(/\/$/, "");
        if (pushConfigured(env)) await sendPush({ title: `${t.direction === "long" ? "Trim" : "Cover"} signal: ${sym} (card #${t.cardId})`, message: `${sig} Paper only: the card's track is not changed.`, tags: ["busts_in_silhouette"], priority: 3, ...(base ? { click: `${base}/cards/${t.cardId}` } : {}) }, env, fetchImpl).catch(() => undefined);
      }
    }
  }
  return `crowding: ${measured} stocks measured (${todo.length - measured} left today)${alerts.length ? ` · trim/cover signals: ${alerts.join(", ")}` : ""}`;
}
