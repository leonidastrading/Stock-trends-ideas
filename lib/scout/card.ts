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
  why: z.string().min(1),
  revenue_share_pct: z.number().min(0).max(100).nullable(),
  share_is_estimate: z.boolean(),
  sector: z.enum(SECTOR_KEYS),
});

export const latenessSchema = z.object({
  news_stories_30d: z.number().min(0),
  stock_move_30d_pct: z.number(),
  stock_move_90d_pct: z.number(),
  already_obvious: z.boolean(),
});

export const cardSchema = z.object({
  title: z.string().min(1).max(120),
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
  unknowns: z.array(z.string()),
});
export type Card = z.infer<typeof cardSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type CardTicker = z.infer<typeof tickerSchema>;

/** The reply format sent to the model (structured output). Keep in step with cardSchema; it is part of the version hash. */
export const CARD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "kind", "origin", "observation", "evidence", "tickers", "why_not_priced", "lateness", "catalyst", "direction", "invalidation", "time_limit_days", "scores", "confidence", "unknowns"],
  properties: {
    title: { type: "string", description: "12 words or fewer" },
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
      type: "array", minItems: 1, maxItems: 5,
      items: {
        type: "object", additionalProperties: false, required: ["symbol", "why", "revenue_share_pct", "share_is_estimate", "sector"],
        properties: {
          symbol: { type: "string" }, why: { type: "string" },
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
    time_limit_days: { type: "integer", minimum: 1, maximum: SCOUT.maxTimeLimitDays },
    scores: {
      type: "object", additionalProperties: false, required: ["novelty", "materiality", "breadth_of_evidence", "lateness"],
      properties: { novelty: { type: "number" }, materiality: { type: "number" }, breadth_of_evidence: { type: "number" }, lateness: { type: "number" } },
    },
    confidence: { type: "number", minimum: 0, maximum: 100 },
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
 *  2. materiality: the primary ticker's line under 10% of revenue, or no estimate at all, is logged but not promoted;
 *  3. lateness: measured 30-day move above 30% or more than 20 stories in 30 days = already obvious = "late".
 * The card's lateness block is replaced with the measured numbers where they exist.
 */
export function applyGates(input: Card, measured: MeasuredLateness): GateResult {
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
  const lateNews = lateness.news_stories_30d > SCOUT.lateNewsStories30d;
  if (late30) notes.push(`stock up ${lateness.stock_move_30d_pct.toFixed(1)}% in 30 days (gate: ${SCOUT.lateStockMove30dPct}%)`);
  if (lateNews) notes.push(`${lateness.news_stories_30d} mainstream stories in 30 days (gate: ${SCOUT.lateNewsStories30d})`);
  if (input.lateness.already_obvious && !late30 && !lateNews) notes.push("model itself judged the idea already obvious");
  lateness.already_obvious = late30 || lateNews || input.lateness.already_obvious;

  const primary = input.tickers[0];
  let status: CardStatus = "promoted";
  if (primary.revenue_share_pct === null) {
    status = "not_promoted";
    notes.push(`materiality: no revenue-share estimate for ${primary.symbol}`);
  } else if (primary.revenue_share_pct < SCOUT.minRevenueSharePct) {
    status = "not_promoted";
    notes.push(`materiality: line is ${primary.revenue_share_pct}% of ${primary.symbol} revenue (gate: ${SCOUT.minRevenueSharePct}%)`);
  } else if (lateness.already_obvious) {
    status = "late";
  }
  if (primary.revenue_share_pct !== null && primary.share_is_estimate) notes.push(`revenue share for ${primary.symbol} is the model's estimate`);

  return { status, notes, card: { ...input, evidence, lateness } };
}

/** Digest ranking: novelty × materiality. */
export const rankScore = (c: Card) => c.scores.novelty * c.scores.materiality;

export function catalystDate(c: Card): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(c.catalyst.date) && !Number.isNaN(Date.parse(c.catalyst.date)) ? c.catalyst.date : null;
}
