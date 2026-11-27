/**
 * The thesis card (section 4 of the spec): zod schema for validation, the JSON
 * schema sent to the model, and the gates. Everything here is pure.
 */
import { z } from "zod";
import { KINDS, SCOUT, SECTOR_KEYS } from "@/config/scout";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const score = z.number().min(0).max(10);

export const evidenceSchema = z.object({
  source: z.string().min(1),
  metric: z.string().min(1),
  value: z.string().min(1),
  change_vs_12m: z.string(),
  as_of: date,
});

export const tickerSchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/, "1–5 letters"),
  /** The issuer's name, so the code can check the symbol still means this company (absent on older cards). */
  company: z.string().max(120).optional(),
  why: z.string().min(1),
  revenue_share_pct: z.number().min(0).max(100).nullable(),
  share_is_estimate: z.boolean(),
  sector: z.enum(SECTOR_KEYS),
});

/**
 * What the trade depends on, for the size gate. "whole_company": the catalyst and the exit are company-wide results
 * and the theme is the reason to look. "line": the trade works only if that product or line itself grows; then a
 * line under the size gate needs a measured figure for the line itself. Absent on cards before it existed.
 */
export const sizeBasisSchema = z.object({
  depends_on: z.enum(["whole_company", "line"]),
  why: z.string().max(400),
  line_figure: z.string().max(300).nullable(),
  line_figure_source: z.string().max(200).nullable(),
  line_figure_as_of: z.string().max(20).nullable(),
});
export type SizeBasis = z.infer<typeof sizeBasisSchema>;

export const latenessSchema = z.object({
  news_stories_30d: z.number().min(0),
  stock_move_30d_pct: z.number(),
  stock_move_90d_pct: z.number(),
  already_obvious: z.boolean(),
});

export const cardSchema = z.object({
  title: z.string().min(1).max(120),
  /** One plain sentence: direction, ticker, reason, what should happen by when. Cards before this field have none. */
  thesis: z.string().max(400).optional(),
  kind: z.enum(KINDS),
  origin: z.enum(["scout", "human"]),
  observation: z.string().min(1),
  evidence: z.array(evidenceSchema),
  tickers: z.array(tickerSchema).min(1).max(5),
  why_not_priced: z.string(),
  lateness: latenessSchema,
  catalyst: z.object({ what: z.string(), date: z.string() }),
  direction: z.enum(["long", "short"]),
  invalidation: z.string().min(1),
  time_limit_days: z.number().int().min(1).max(SCOUT.maxTimeLimitDays),
  scores: z.object({ novelty: score, materiality: score, breadth_of_evidence: score, lateness: score }),
  confidence: z.number().min(0).max(100),
  /** How a trader might express it given the expected path and timing. Advice only; tracking is in shares. Absent on cards before it existed. */
  expression: z.string().max(600).optional(),
  size_basis: sizeBasisSchema.optional(),
  unknowns: z.array(z.string()),
});
export type Card = z.infer<typeof cardSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type CardTicker = z.infer<typeof tickerSchema>;

/**
 * The reply format sent to the model (structured output). Keep in step with
 * cardSchema; it is part of the version hash. Structured outputs accept only a
 * subset of JSON Schema: no minItems/maxItems, minimum/maximum or pattern, so
 * ranges are described in words here and enforced by cardSchema after parsing.
 */
export const CARD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "thesis", "kind", "origin", "observation", "evidence", "tickers", "why_not_priced", "lateness", "catalyst", "direction", "invalidation", "time_limit_days", "scores", "confidence", "expression", "size_basis", "unknowns"],
  properties: {
    title: { type: "string", description: "12 words or fewer, in plain English a non-expert gets at a glance: what happened and what it means for which company (e.g. 'FBI warns of a new AI hacking tool; could lift demand for CrowdStrike'). No trader jargon (read-through, print, beat-and-raise, TAM) and no unexplained acronyms or code names" },
    thesis: { type: "string", description: "The thesis as ONE plain-English sentence of 35 words or fewer that a non-expert understands at a glance: start with the one word Long or Short and the ticker (one side only: never 'Long nothing; Short X'), then what happened, why the stock should keep moving, and by when (e.g. 'Long PANW: the 26% drop already prices in the fears, so a clean earnings report around Nov 19 should spark a rebound against the market within 30 days'; 'Short PLXS: the stock fell 10% after a senior executive left without explanation, and falls on unexplained departures tend to continue for weeks, so it should lag the market over the next 28 days'). Say the cause in everyday words rather than naming a mechanism ('news drift', 'unwind', 'read-through', 'premium leaking out'). Only the card's own facts; acronyms spelled out." },
    kind: { type: "string", enum: [...KINDS] },
    origin: { type: "string", enum: ["scout", "human"] },
    observation: { type: "string", description: "What changed, with the numbers and dates" },
    evidence: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["source", "metric", "value", "change_vs_12m", "as_of"],
        properties: { source: { type: "string" }, metric: { type: "string" }, value: { type: "string" }, change_vs_12m: { type: "string" }, as_of: { type: "string", description: "YYYY-MM-DD" } },
      },
    },
    tickers: {
      type: "array", description: "1 to 5 tickers, most direct exposure first",
      items: {
        type: "object", additionalProperties: false, required: ["symbol", "company", "why", "revenue_share_pct", "share_is_estimate", "sector"],
        properties: {
          symbol: { type: "string" }, company: { type: "string", description: "the issuer's name, e.g. EchoStar Corporation" }, why: { type: "string" },
          revenue_share_pct: { type: ["number", "null"], description: "Share of the company's revenue from the product or line; null if you cannot estimate" },
          share_is_estimate: { type: "boolean" },
          sector: { type: "string", enum: [...SECTOR_KEYS] },
        },
      },
    },
    why_not_priced: { type: "string" },
    lateness: {
      type: "object", additionalProperties: false, required: ["news_stories_30d", "stock_move_30d_pct", "stock_move_90d_pct", "already_obvious"],
      properties: { news_stories_30d: { type: "number" }, stock_move_30d_pct: { type: "number" }, stock_move_90d_pct: { type: "number" }, already_obvious: { type: "boolean" } },
    },
    catalyst: { type: "object", additionalProperties: false, required: ["what", "date"], properties: { what: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD or 'unknown'" } } },
    direction: { type: "string", enum: ["long", "short"] },
    invalidation: { type: "string" },
    time_limit_days: { type: "integer", description: `1 to ${SCOUT.maxTimeLimitDays} days` },
    scores: {
      type: "object", additionalProperties: false, required: ["novelty", "materiality", "breadth_of_evidence", "lateness"],
      properties: { novelty: { type: "number", description: "0-10" }, materiality: { type: "number", description: "0-10" }, breadth_of_evidence: { type: "number", description: "0-10" }, lateness: { type: "number", description: "0-10" } },
    },
    confidence: { type: "number", description: "0-100: probability the primary ticker, in the stated direction, beats SPY from the next open to the exit" },
    expression: { type: "string", description: "How to trade it given the expected path and timing, one or two sentences: shares, or an options structure with the time to expiry the move needs; not a recommendation" },
    size_basis: {
      type: "object", additionalProperties: false, required: ["depends_on", "why", "line_figure", "line_figure_source", "line_figure_as_of"],
      description: "What the trade depends on, for the size gate",
      properties: {
        depends_on: { type: "string", enum: ["whole_company", "line"], description: "whole_company: the catalyst and the invalidation you wrote are company-wide results (total sales, earnings, guidance, the whole stock recovering from a sell-off). line: the trade pays only if this product or line itself grows" },
        why: { type: "string", description: "One sentence: which results decide the trade" },
        line_figure: { type: ["string", "null"], description: "For depends_on = line only: one measured figure for the line itself, with its number (what the company disclosed for it, or its measured growth). null when there is none or for whole_company" },
        line_figure_source: { type: ["string", "null"], description: "Where that figure is from: one of the measurements given, or a company filing, release or call you can name. null with no figure" },
        line_figure_as_of: { type: ["string", "null"], description: "YYYY-MM-DD of that figure. null with no figure" },
      },
    },
    unknowns: { type: "array", items: { type: "string" } },
  },
} as const;

/** Parse the model's text. Throws with a readable message on bad JSON or schema failures. */
export function parseCard(text: string): Card {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("reply is not valid JSON");
  }
  const r = cardSchema.safeParse(raw);
  if (!r.success) throw new Error(`card failed validation: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** Numbers the code measured itself (never the model's own). */
export interface MeasuredLateness {
  newsStories30d: number | null;
  stockMove30dPct: number | null;
  stockMove90dPct: number | null;
  /** false = the price feed returned no bars for the primary ticker (a foreign or unlisted symbol); undefined = not checked. */
  hasPrices?: boolean;
  /** Latest close and the move over the last 5 sessions (short-squeeze checks). */
  lastClose?: number | null;
  stockMove5dPct?: number | null;
  /** Mainstream stories per 30 days over the 90 days before (the stock's normal coverage). */
  newsBaseline30d?: number | null;
}

export type CardStatus = "promoted" | "late" | "not_promoted";

export interface GateResult {
  status: CardStatus;
  notes: string[];
  card: Card;
}

export class NoEvidenceError extends Error {}

/**
 * Apply the gates, in order:
 *  1. evidence: every item needs a source and a date; items without are dropped; none left = no card;
 *  2. materiality: the primary ticker's line under 10% of revenue, or no estimate at all, is logged but not promoted,
 *     unless the trade depends on company-wide results, or the card gives a measured figure for the line (sizeVerdict);
 *  3. lateness: measured 30-day move above 30% or more than 20 stories in 30 days = already obvious = "late".
 * The card's lateness block is replaced with the measured numbers where they exist.
 */
export interface GateOptions {
  /** Story trades: the thesis is about the whole company, so a missing revenue share means 100%, not "unknown". */
  wholeCompany?: boolean;
}

/** The gate note on a short under $5 (such cards are kept in the log but hidden from the Ideas list). */
export const PENNY_SHORT_NOTE = "no shorts under $5";

/** Pure: a card the scout must not suggest: a short on a stock under $5 (by its gate note, or the price when known). */
export function isPennyShort(c: { direction: string; gateNotes: string[] }, price?: number | null): boolean {
  if (c.direction !== "short") return false;
  if (c.gateNotes.some((n) => n.startsWith(PENNY_SHORT_NOTE) || /is under \$5\b/.test(n))) return true;
  return price !== undefined && price !== null && price < SCOUT.minShortPrice;
}

export type SizeTag = "whole_company" | "small_today";
export interface SizeVerdict { pass: boolean; note: string | null; tag: SizeTag | null }
const SIZE_NOTE: Record<SizeTag, string> = { whole_company: "size: whole-company trade", small_today: "size: small today" };

/**
 * Pure: the size gate. A card passes when its line is at least 10% of the primary ticker's revenue. Under that, it
 * passes in two cases, each with its own note so the Scoreboard can score the group apart:
 *  - the trade depends on company-wide results (the theme is the reason to look, total sales or earnings decide it);
 *  - the line is small today but the card gives a measured figure for the line itself, with a source and a date.
 */
export function sizeVerdict(card: Pick<Card, "tickers" | "size_basis">): SizeVerdict {
  const primary = card.tickers[0], share = primary.revenue_share_pct, basis = card.size_basis;
  if (share !== null && share >= SCOUT.minRevenueSharePct) return { pass: true, note: null, tag: null };
  const line = share === null ? "has no revenue-share estimate" : `is about ${share}% of ${primary.symbol} revenue`;
  if (basis?.depends_on === "whole_company") return { pass: true, tag: "whole_company", note: `${SIZE_NOTE.whole_company}: ${basis.why.trim().replace(/[.\s]+$/, "") || "company-wide results decide it"}; the theme itself ${line} (gate: ${SCOUT.minRevenueSharePct}%)` };
  if (share === null) return { pass: false, tag: null, note: `materiality: no revenue-share estimate for ${primary.symbol}` };
  const fig = basis?.line_figure?.trim() ?? "", src = basis?.line_figure_source?.trim() ?? "", asOf = basis?.line_figure_as_of?.trim() ?? "";
  if (basis?.depends_on === "line" && /\d/.test(fig) && src && /^\d{4}-\d{2}-\d{2}$/.test(asOf) && !Number.isNaN(Date.parse(asOf))) {
    return { pass: true, tag: "small_today", note: `${SIZE_NOTE.small_today}: the line ${line} (gate: ${SCOUT.minRevenueSharePct}%), promoted on a figure for the line itself: ${fig} (${src}, ${asOf}; the researcher's citation)` };
  }
  return { pass: false, tag: null, note: `materiality: line is ${share}% of ${primary.symbol} revenue (gate: ${SCOUT.minRevenueSharePct}%)` };
}

/** Pure: which size exception a stored card passed on, from its gate notes (null: none, or a card from before the exceptions). */
export function sizeTagOf(gateNotes: string[]): SizeTag | null {
  return gateNotes.some((n) => n.startsWith(SIZE_NOTE.whole_company)) ? "whole_company" : gateNotes.some((n) => n.startsWith(SIZE_NOTE.small_today)) ? "small_today" : null;
}

/** Pure: the size group a card is scored in on the Scoreboard. */
export const SIZE_GROUPS = ["10% of revenue or more", "whole-company trade on a small theme", "small today, with a figure for the line", "held back for size"] as const;
export function sizeGroup(c: { gateNotes: string[]; card: Pick<Card, "tickers"> }): (typeof SIZE_GROUPS)[number] | null {
  const tag = sizeTagOf(c.gateNotes);
  if (tag) return tag === "whole_company" ? SIZE_GROUPS[1] : SIZE_GROUPS[2];
  if (c.gateNotes.some((n) => n.startsWith("materiality: "))) return SIZE_GROUPS[3];
  const share = c.card.tickers[0]?.revenue_share_pct ?? null;
  return share !== null && share >= SCOUT.minRevenueSharePct ? SIZE_GROUPS[0] : null;
}

export function applyGates(input: Card, measured: MeasuredLateness, opts: GateOptions = {}): GateResult {
  const notes: string[] = [];
  const evidence = input.evidence.filter((e) => e.source.trim() && /^\d{4}-\d{2}-\d{2}$/.test(e.as_of) && !Number.isNaN(Date.parse(e.as_of)));
  if (evidence.length < input.evidence.length) notes.push(`${input.evidence.length - evidence.length} evidence item(s) dropped: missing source or date`);
  if (!evidence.length) throw new NoEvidenceError("no evidence with a source and a date: no card");

  const lateness = {
    news_stories_30d: measured.newsStories30d ?? input.lateness.news_stories_30d,
    stock_move_30d_pct: measured.stockMove30dPct ?? input.lateness.stock_move_30d_pct,
    stock_move_90d_pct: measured.stockMove90dPct ?? input.lateness.stock_move_90d_pct,
    already_obvious: input.lateness.already_obvious,
  };
  if (measured.newsStories30d === null) notes.push("news count not measured (news stream unavailable); model's own figure kept");
  if (measured.stockMove30dPct === null) notes.push("stock move not measured (price data unavailable); model's own figure kept");

  const late30 = lateness.stock_move_30d_pct > SCOUT.lateStockMove30dPct;
  // News gate: heavy coverage that is also well above the stock's own normal (big companies are always covered).
  const baseline = measured.newsBaseline30d ?? null;
  const heavy = lateness.news_stories_30d > SCOUT.lateNewsStories30d;
  const lateNews = heavy && (baseline === null || lateness.news_stories_30d >= SCOUT.lateNewsVsUsual * Math.max(baseline, 1));
  if (heavy && !lateNews) notes.push(`${lateness.news_stories_30d} mainstream stories in 30 days, but that is normal for this stock (about ${baseline} a month): not counted as late`);
  if (late30) notes.push(`stock up ${lateness.stock_move_30d_pct.toFixed(1)}% in 30 days (gate: ${SCOUT.lateStockMove30dPct}%)`);
  if (lateNews) notes.push(`${lateness.news_stories_30d} mainstream stories in 30 days (gate: ${SCOUT.lateNewsStories30d}${baseline !== null ? `, and ${SCOUT.lateNewsVsUsual}x its usual ${baseline} a month` : ""})`);
  if (input.lateness.already_obvious && !late30 && !lateNews) notes.push("model itself judged the idea already obvious");
  lateness.already_obvious = late30 || lateNews || input.lateness.already_obvious;

  let primary = input.tickers[0];
  if (opts.wholeCompany && primary.revenue_share_pct === null) {
    primary = { ...primary, revenue_share_pct: 100, share_is_estimate: false };
    notes.push(`whole-company story trade: revenue share taken as 100% for ${primary.symbol}`);
  }
  let status: CardStatus = "promoted";
  if (measured.hasPrices === false) {
    status = "not_promoted";
    notes.push(`no US price data for ${primary.symbol} (foreign or unlisted symbol?): not tracked`);
  } else {
    const size = sizeVerdict({ tickers: [primary, ...input.tickers.slice(1)], size_basis: input.size_basis });
    if (size.note) notes.push(size.note);
    if (!size.pass) status = "not_promoted";
    else if (lateness.already_obvious) status = "late";
  }
  // Shorts that are impractical or dangerous to hold: cheap stocks and fresh run-ups (borrow cost, squeezes).
  // No shorts under $5, whatever else the card failed (the note is what hides it from the Ideas list).
  const shortPx = measured.lastClose ?? null;
  if (input.direction === "short" && shortPx !== null && shortPx < SCOUT.minShortPrice) {
    status = "not_promoted";
    notes.push(`${PENNY_SHORT_NOTE}: $${shortPx.toFixed(2)} is under $${SCOUT.minShortPrice} (hard and costly to borrow, prone to squeezes)`);
  } else if (input.direction === "short" && status !== "not_promoted") {
    const up30 = lateness.stock_move_30d_pct, up5 = measured.stockMove5dPct ?? null;
    const why = up30 > SCOUT.maxShortRunUp30dPct ? `up ${up30.toFixed(1)}% in 30 days (limit ${SCOUT.maxShortRunUp30dPct}%): squeeze risk`
        : up5 !== null && up5 > SCOUT.maxShortRunUp5dPct ? `up ${up5.toFixed(1)}% in 5 days (limit ${SCOUT.maxShortRunUp5dPct}%): squeeze risk` : null;
    if (why) {
      status = "not_promoted";
      notes.push(`short not promoted: ${why}; defined-risk puts or no trade`);
    }
  }
  if (primary.revenue_share_pct !== null && primary.share_is_estimate) notes.push(`revenue share for ${primary.symbol} is the model's estimate`);

  return { status, notes, card: { ...input, evidence, lateness, tickers: [primary, ...input.tickers.slice(1)] } };
}

/** Digest ranking: novelty × materiality. */
export const rankScore = (c: Card) => c.scores.novelty * c.scores.materiality;

export function catalystDate(c: Card): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(c.catalyst.date) && !Number.isNaN(Date.parse(c.catalyst.date)) ? c.catalyst.date : null;
}
