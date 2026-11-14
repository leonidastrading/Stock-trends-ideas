/**
 * Post-catalyst check. The day after a card's catalyst date, the scout reads
 * the headlines since the catalyst and the price moves, and records a short
 * verdict: did the thesis play out? Reviews are commentary for Vadim: they
 * never change a card, its gates or its paper track, and they are not part of
 * the scored version.
 */
import { z } from "zod";
import type { MarketData } from "../alpaca";
import { addDays, toEt } from "../time";
import type { CallModel } from "./llm";
import * as store from "./store";
import type { StoredCard, Track } from "./store";

export const REVIEW_SYSTEM_PROMPT = `You check, after the fact, whether a paper trade's thesis played out at its catalyst. You get the trade card (direction, thesis, catalyst, invalidation), the stock's price moves around the catalyst, and the headlines since the day before the catalyst. Use only what you are given.

Reply with:
- verdict: "played_out" (the catalyst went the card's way and the stock moved in the card's direction), "did_not" (the catalyst went against the thesis, or the invalidation was met), "mixed" (the news and the price disagree, or only part of the thesis held), or "too_early" (the catalyst has not happened yet or there is no news on it).
- summary: at most two plain sentences, with the numbers and dates that decide the verdict.
- evidence: up to three headlines that support the verdict, with their date and source.
This is a record for the trader, not advice. Do not suggest a new trade.`;

export const reviewSchema = z.object({
  verdict: z.enum(["played_out", "did_not", "mixed", "too_early"]),
  summary: z.string().min(1).max(600),
  evidence: z.array(z.object({ date: z.string(), source: z.string(), headline: z.string() })),
});
export type Review = z.infer<typeof reviewSchema>;

export const REVIEW_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["verdict", "summary", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["played_out", "did_not", "mixed", "too_early"] },
    summary: { type: "string", description: "at most two sentences, with numbers and dates" },
    evidence: {
      type: "array", description: "up to three headlines",
      items: { type: "object", additionalProperties: false, required: ["date", "source", "headline"], properties: { date: { type: "string" }, source: { type: "string" }, headline: { type: "string" } } },
    },
  },
} as const;

export function parseReview(text: string): Review {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("review reply is not valid JSON");
  }
  const r = reviewSchema.safeParse(raw);
  if (!r.success) throw new Error(`review failed validation: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { ...r.data, evidence: r.data.evidence.slice(0, 3) };
}

export interface PriceContext { entry: number | null; entryDate: string | null; beforeCatalyst: number | null; last: number | null; lastDate: string | null; spyChange: number | null }

const pct = (a: number | null, b: number | null) => (a && b ? Math.round((b / a - 1) * 1000) / 10 : null);

/** Signed for the card's direction: positive = the trade is winning. */
export function directionalMove(direction: "long" | "short", from: number | null, to: number | null): number | null {
  const m = pct(from, to);
  return m === null ? null : direction === "long" ? m : -m;
}

export function buildReviewPrompt(c: StoredCard, p: PriceContext, headlines: Array<{ ts: string; headline: string; source: string }>, today: string): string {
  const k = c.card;
  const L = [
    `Today: ${today}. Card #${c.id}: ${c.direction.toUpperCase()} ${c.primaryTicker} — ${k.title}`,
    `Thesis: ${k.observation}`,
    `Why the market was missing it: ${k.why_not_priced}`,
    `Catalyst: ${k.catalyst.what} (date ${c.catalystDate})`,
    `Invalidation: ${k.invalidation}`,
    "",
    "Prices (daily closes; moves signed so positive = in the card's favour):",
    `- Paper entry: ${p.entry ?? "not entered"}${p.entryDate ? ` on ${p.entryDate}` : ""}; latest close ${p.last ?? "n/a"}${p.lastDate ? ` on ${p.lastDate}` : ""}; move for the trade since entry: ${directionalMove(c.direction, p.entry, p.last) ?? "n/a"}%`,
    `- Close before the catalyst: ${p.beforeCatalyst ?? "n/a"}; move for the trade since then: ${directionalMove(c.direction, p.beforeCatalyst, p.last) ?? "n/a"}%`,
    `- SPY over the same window since the catalyst: ${p.spyChange ?? "n/a"}%`,
    "",
    `Headlines tagged ${c.primaryTicker} since the day before the catalyst (newest first):`,
    ...(headlines.length ? headlines.map((h) => `- ${h.ts.slice(0, 10)} [${h.source}] ${h.headline}`) : ["- none found"]),
  ];
  return L.join("\n");
}

/** Cards whose catalyst date has passed (at least a day ago), not yet reviewed, still tracked or recently closed. */
export function dueForReview(cards: StoredCard[], tracks: Track[], reviewed: Set<number>, today: string): StoredCard[] {
  const tracked = new Set(tracks.map((t) => t.cardId));
  const oldest = addDays(today, -60);
  return cards.filter((c) => c.catalystDate && c.catalystDate < today && c.catalystDate >= oldest && tracked.has(c.id) && !reviewed.has(c.id));
}

export interface ReviewDeps { data: MarketData | null; callModel: CallModel; now: Date }

export async function runReviews(deps: ReviewDeps, max = 8): Promise<Array<{ cardId: number; verdict: string } | { cardId: number; error: string }>> {
  const out: Array<{ cardId: number; verdict: string } | { cardId: number; error: string }> = [];
  if (!deps.data) return out;
  const today = toEt(deps.now).date;
  const settings = await store.loadSettings();
  const [cards, tracks, reviewed] = await Promise.all([store.cardsSince(120), store.allTracks(), store.reviewedCardIds()]);
  const trackBy = new Map(tracks.map((t) => [t.cardId, t]));
  for (const c of dueForReview(cards, tracks, reviewed, today).slice(0, max)) {
    const spend = await store.spendOn(today);
    if (spend.cost >= settings.dailyCapUsd) break;
    try {
      const t = trackBy.get(c.id)!;
      const from = addDays(c.catalystDate!, -6);
      const bars = await store.loadBars([c.primaryTicker, "SPY"], from, today);
      const sym = bars.filter((b) => b.symbol === c.primaryTicker);
      const spy = bars.filter((b) => b.symbol === "SPY");
      const before = (xs: typeof bars) => xs.filter((b) => b.date <= c.catalystDate!).at(-1)?.c ?? null;
      const p: PriceContext = { entry: t.entryPrice, entryDate: t.entryDate, beforeCatalyst: before(sym), last: sym.at(-1)?.c ?? null, lastDate: sym.at(-1)?.date ?? null, spyChange: pct(before(spy), spy.at(-1)?.c ?? null) };
      const news = await deps.data.getNews([c.primaryTicker], new Date(`${addDays(c.catalystDate!, -1)}T00:00:00Z`), deps.now, 40);
      const prompt = buildReviewPrompt(c, p, news.slice(0, 15), today);
      const reply = await deps.callModel({ model: settings.model, effort: "low", user: prompt, purpose: "review" });
      await store.logLlmCall({ etDate: today, model: settings.model, purpose: "review", usage: reply.usage, costUsd: reply.costUsd, ok: true });
      const r = parseReview(reply.text);
      await store.insertReview({ cardId: c.id, verdict: r.verdict, summary: r.summary, evidence: r.evidence, moveSinceEntryPct: directionalMove(c.direction, p.entry, p.last), model: settings.model });
      out.push({ cardId: c.id, verdict: r.verdict });
    } catch (err) {
      out.push({ cardId: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
