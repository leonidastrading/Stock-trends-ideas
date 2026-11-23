/**
 * Read-only card API for an outside dashboard (GET /api/cards/[id]): one card as plain JSON, behind a bearer token
 * (SCOUT_API_TOKEN) instead of the site login. Pure parts here; the route does the reading.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { STAGE_LABEL, type CrowdingRow } from "./crowding";
import type { StoredCard, Track } from "./store";

export { isCardApiRequest } from "./card-api-path";

/** Constant-time check of "Authorization: Bearer <token>" against the expected token (hashes first, so lengths never leak). */
export function bearerOk(header: string | null, expected: string | undefined): boolean {
  const want = expected?.trim();
  const m = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!want || want.length < 32 || !m) return false;
  const a = createHash("sha256").update(m[1]).digest(), b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** Pure: drop undefined, null, empty strings and empty arrays/objects, recursively (fields a card lacks are left out). */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact).filter((x) => !empty(x)) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)]).filter(([, x]) => !empty(x))) as T;
  return v;
}
const empty = (x: unknown) => x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length) || (typeof x === "object" && x !== null && !Array.isArray(x) && !Object.keys(x).length);

const reading = (r: CrowdingRow | null) => r && compact({
  measured_on: r.measuredOn, score: r.score, stage: r.stage, stage_label: r.stage !== null ? STAGE_LABEL[r.stage] : null,
  stocktwits_bullish_share: r.parts?.attention?.bullishShare ?? null, stocktwits_posts_per_hour: r.parts?.attention?.perHour ?? null,
  news_stories_30d: r.parts?.news?.stories30d ?? null, move_30d_pct: r.parts?.run?.move30 ?? null, pct_vs_200d_average: r.parts?.extension?.pctAbove ?? null,
});

/** Pure: the card as the API returns it. */
export function cardForApi(c: StoredCard, t: Track | null, crowd: { entry: CrowdingRow | null; latest: CrowdingRow | null } | null, baseUrl: string) {
  const card = c.card, [primary, ...others] = card.tickers;
  const catalystDate = /^\d{4}-\d{2}-\d{2}$/.test(card.catalyst?.date ?? "") ? card.catalyst.date : c.catalystDate;
  return compact({
    id: c.id,
    url: `${baseUrl.replace(/\/$/, "")}/cards/${c.id}`,
    created_at: c.createdAt,
    status: c.status,
    promoted: c.status === "promoted",
    origin: c.origin,
    kind: c.kind,
    title: card.title,
    ticker: primary?.symbol ?? c.primaryTicker,
    company: primary?.company,
    direction: c.direction,
    thesis: card.thesis,
    observation: card.observation,
    variant_perception: card.why_not_priced,
    invalidation: card.invalidation,
    catalyst: card.catalyst?.what,
    catalyst_date: catalystDate,
    time_limit_days: c.timeLimitDays,
    exit_by: t?.deadlineDate,
    entry: t?.entryDate ? { date: t.entryDate, price: t.entryPrice, price_as_recorded: t.entryPriceRaw !== undefined && t.entryPriceRaw !== t.entryPrice ? t.entryPriceRaw : null } : null,
    exit: t?.exitDate ? { date: t.exitDate, price: t.exitPrice, reason: t.exitReason } : null,
    invalidated: t?.invalidatedAt ? { at: t.invalidatedAt, note: t.invalidatedNote } : null,
    sector: primary?.sector ?? c.sector,
    sector_etf: t?.sectorEtf,
    benchmark: "SPY",
    confidence: card.confidence,
    scores: card.scores,
    expression: card.expression,
    crowding: crowd ? { at_entry: reading(crowd.entry), latest: reading(crowd.latest) } : null,
    lateness: card.lateness,
    other_tickers: others.map((x) => ({ symbol: x.symbol, company: x.company, why: x.why })),
    primary_ticker_why: primary?.why,
    evidence: card.evidence,
    unknowns: card.unknowns,
  });
}
