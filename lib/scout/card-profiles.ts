/**
 * Market cap and short interest per card, frozen once (never edited), so results can later be split by company size
 * and by how heavily shorted the stock was. Captured by the upkeep job, normally the day the card is written; a
 * snapshot taken more than 3 days after the card is marked "late" (older cards, filled in when this started).
 */
import { query as q } from "../db";
import { capBucket, stockProfile } from "../market/profile";
import { daysBetween, toEt } from "../time";
import * as store from "./store";

export interface CardProfile { cardId: number; symbol: string; capturedAt: string; marketCap: number | null; capBucket: string | null; shortPctFloat: number | null; shortPctOut: number | null; daysToCover: number | null; squeeze: string | null; shortAsOf: string | null; late: boolean }

export const SIZE_BANDS = ["nano or micro cap (under $300M)", "small cap ($300M–2B)", "mid cap ($2–10B)", "large cap ($10–200B)", "mega cap ($200B+)", "size unknown"] as const;
export const SHORT_BANDS = ["under 5% short", "5–10% short", "10–20% short", "20%+ short", "short interest unknown"] as const;

/** Pure: the size band a card falls in. */
export function sizeBand(p: CardProfile | undefined): (typeof SIZE_BANDS)[number] {
  const v = p?.marketCap ?? null;
  if (v === null) return "size unknown";
  return v < 300e6 ? SIZE_BANDS[0] : v < 2e9 ? SIZE_BANDS[1] : v < 10e9 ? SIZE_BANDS[2] : v < 200e9 ? SIZE_BANDS[3] : SIZE_BANDS[4];
}

/** Pure: the short-interest band (% of float, else % of shares outstanding). */
export function shortBand(p: CardProfile | undefined): (typeof SHORT_BANDS)[number] {
  const v = p?.shortPctFloat ?? p?.shortPctOut ?? null;
  if (v === null) return "short interest unknown";
  return v < 5 ? SHORT_BANDS[0] : v < 10 ? SHORT_BANDS[1] : v < 20 ? SHORT_BANDS[2] : SHORT_BANDS[3];
}

/** Size filter keys for the Ideas page, smallest first. */
export const SIZE_KEYS = [
  { key: "micro", label: "Micro cap (<$300M)", max: 300e6 },
  { key: "small", label: "Small ($300M–2B)", max: 2e9 },
  { key: "mid", label: "Mid ($2–10B)", max: 10e9 },
  { key: "large", label: "Large ($10–200B)", max: 200e9 },
  { key: "mega", label: "Mega ($200B+)", max: Infinity },
] as const;
export const SHORT_MINS = [5, 10, 20] as const;

/** Pure: the size filter key for a market cap. */
export function sizeKey(cap: number | null | undefined): string | null {
  if (cap === null || cap === undefined) return null;
  return SIZE_KEYS.find((s) => cap < s.max)!.key;
}

/** Pure: % of float short (else % of shares outstanding). */
export const shortPct = (p: Pick<CardProfile, "shortPctFloat" | "shortPctOut"> | undefined) => p?.shortPctFloat ?? p?.shortPctOut ?? null;

/**
 * The profile each card is filtered by: its frozen snapshot, else the stock's cached live profile (cards written since
 * the last upkeep run). Never fetches.
 */
export async function profilesForCards(cards: Array<{ id: number; primaryTicker: string }>): Promise<Map<number, Pick<CardProfile, "marketCap" | "shortPctFloat" | "shortPctOut">>> {
  const frozen = await cardProfiles().catch(() => new Map<number, CardProfile>());
  const missing = [...new Set(cards.filter((c) => !frozen.has(c.id)).map((c) => c.primaryTicker))];
  const live = new Map<string, { marketCap: number | null; short: { pctFloat?: number | null; pctOutstanding: number | null } | null }>();
  if (missing.length) {
    const rows = await q(`SELECT key, data FROM dashboard_cache WHERE key = ANY($1)`, [missing.map((s) => `profile:${s}`)]).catch(() => []);
    for (const r of rows) live.set(String(r.key).slice(8), r.data as never);
  }
  const out = new Map<number, Pick<CardProfile, "marketCap" | "shortPctFloat" | "shortPctOut">>();
  for (const c of cards) {
    const f = frozen.get(c.id);
    if (f) { out.set(c.id, f); continue; }
    const l = live.get(c.primaryTicker);
    if (l) out.set(c.id, { marketCap: l.marketCap ?? null, shortPctFloat: l.short?.pctFloat ?? null, shortPctOut: l.short?.pctOutstanding ?? null });
  }
  return out;
}

export async function cardProfiles(): Promise<Map<number, CardProfile>> {
  const rows = await q(`SELECT * FROM card_profiles`);
  return new Map(rows.map((r) => [Number(r.card_id), {
    cardId: Number(r.card_id), symbol: String(r.symbol), capturedAt: new Date(r.captured_at as string).toISOString(),
    marketCap: r.market_cap === null ? null : Number(r.market_cap), capBucket: (r.cap_bucket as string) ?? null,
    shortPctFloat: r.short_pct_float === null ? null : Number(r.short_pct_float), shortPctOut: r.short_pct_out === null ? null : Number(r.short_pct_out),
    daysToCover: r.days_to_cover === null ? null : Number(r.days_to_cover), squeeze: (r.squeeze as string) ?? null, shortAsOf: (r.short_as_of as string) ?? null, late: !!r.late,
  }]));
}

/** Upkeep: freeze the profile of cards that have none yet (newest first, a few per call). */
export async function captureCardProfiles(now: Date, deadline: number, max = 40): Promise<string> {
  const [cards, have] = await Promise.all([store.cardsSince(400), cardProfiles()]);
  const todo = cards.filter((c) => !have.has(c.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, max);
  let n = 0, late = 0;
  for (const c of todo) {
    if (Date.now() > deadline) break;
    const p = await stockProfile(c.primaryTicker, null).catch(() => null);
    if (!p) continue;
    const isLate = daysBetween(toEt(new Date(c.createdAt)).date, toEt(now).date) > 3;
    await q(`INSERT INTO card_profiles (card_id, symbol, captured_at, market_cap, cap_bucket, short_pct_float, short_pct_out, days_to_cover, squeeze, short_as_of, late) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (card_id) DO NOTHING`,
      [c.id, c.primaryTicker, now.toISOString(), p.marketCap, capBucket(p.marketCap), p.short?.pctFloat ?? null, p.short?.pctOutstanding ?? null, p.short?.daysToCover ?? null, p.short?.squeeze ?? null, p.short?.asOf ?? null, isLate]);
    n++;
    if (isLate) late++;
  }
  const left = cards.filter((c) => !have.has(c.id)).length - n;
  return `${n} captured${late ? ` (${late} late)` : ""}${left > 0 ? `, ${left} to go` : ""}`;
}
