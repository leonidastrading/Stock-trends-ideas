/**
 * Cards written before their stock trades (an IPO the week after, a spin-off, a new listing). The ticker check drops a
 * symbol that is not listed yet, and with no price the card is "not promoted", so the idea was never followed. This
 * watch looks at those cards while their time limit runs. Once the symbol trades as the named company's stock and
 * the card passes the mechanical gates it skipped (materiality; for shorts, the $5 floor and the run-up limits), it
 * starts the card's paper track: entry at the next open after the listing was seen, never a past price, and the
 * card's original deadline. The card itself is not changed; a track event records when and why tracking began.
 * Scoring counts these with the late cards, not the promoted ones (they were not promoted when written).
 */
import { SCOUT, SECTORS, type Sector } from "@/config/scout";
import type { DailyBar, MarketData } from "../alpaca";
import { addDays, toEt } from "../time";
import { namesMatch, notCommon } from "./identity";
import * as store from "./store";

/** How long after the card a listing is still watched for (and never past the card's time limit). */
export const LISTING_WAIT_DAYS = 60;

const NOT_LISTED = /is not a listed symbol now|does not trade/;
const NO_PRICES = /no US price data for/;

/** Pure: a card that was not followed only because its stock did not trade yet, still inside its time limit and the wait. */
export function waitingForListing(c: Pick<store.StoredCard, "status" | "gateNotes" | "createdAt" | "timeLimitDays">, today: string): boolean {
  if (c.status !== "not_promoted") return false;
  if (!c.gateNotes.some((n) => NO_PRICES.test(n)) || !c.gateNotes.some((n) => NOT_LISTED.test(n))) return false;
  const day = c.createdAt.slice(0, 10);
  return today <= addDays(day, Math.min(c.timeLimitDays, LISTING_WAIT_DAYS));
}

/** Pure: the gates the card skipped because there was no price, run now on the listed stock. Null when it passes. */
export function gateNow(c: Pick<store.StoredCard, "direction" | "card">, bars: DailyBar[]): string | null {
  const primary = c.card.tickers[0];
  if (primary.revenue_share_pct === null) return `materiality: no revenue-share estimate for ${primary.symbol}`;
  if (primary.revenue_share_pct < SCOUT.minRevenueSharePct) return `materiality: ${primary.revenue_share_pct}% of revenue (gate ${SCOUT.minRevenueSharePct}%)`;
  if (c.direction === "short") {
    const sorted = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted[sorted.length - 1];
    if (!last) return "no price yet";
    if (last.c < SCOUT.minShortPrice) return `short under $${SCOUT.minShortPrice}`;
    const from = sorted[Math.max(0, sorted.length - 22)];
    const up = (last.c / from.c - 1) * 100;
    if (up > SCOUT.maxShortRunUp30dPct) return `short not followed: up ${up.toFixed(1)}% since listing (limit ${SCOUT.maxShortRunUp30dPct}%): squeeze risk`;
  }
  return null;
}

/** One pass over the waiting cards. Returns a summary. */
export async function runListingWatch(data: MarketData | null, now: Date): Promise<string> {
  if (!data?.getAsset) return "skipped: no market data";
  const today = toEt(now).date;
  const [cards, tracks, events] = await Promise.all([store.cardsSince(LISTING_WAIT_DAYS + 5), store.allTracks(), store.trackEvents()]);
  const tracked = new Set([...tracks.map((t) => t.cardId), ...events.filter((e) => e.kind === "listing_not_followed").map((e) => e.cardId)]);
  const waiting = cards.filter((c) => !tracked.has(c.id) && waitingForListing(c, today));
  if (!waiting.length) return "no cards waiting for a listing";
  const out: string[] = [];
  for (const c of waiting) {
    const sym = c.primaryTicker;
    const company = c.card.tickers[0]?.company ?? null;
    const asset = await data.getAsset(sym).catch(() => null);
    if (!asset?.tradable) { out.push(`#${c.id} ${sym}: not listed yet`); continue; }
    if (notCommon(asset.name) || (company && !namesMatch(company, asset.name))) { out.push(`#${c.id} ${sym}: trades as "${asset.name}", not ${company ?? "the company"}`); continue; }
    const bars = await data.getDailyBars([sym], addDays(today, -45), today).catch(() => [] as DailyBar[]);
    if (!bars.length) { out.push(`#${c.id} ${sym}: listed, no prices yet`); continue; }
    const why = gateNow(c, bars);
    if (why) {
      await store.addTrackEvent(c.id, "listing_not_followed", `${sym} trades since ${bars[0].date}; ${why}`).catch(() => undefined);
      out.push(`#${c.id} ${sym}: listed, not followed (${why})`);
      continue;
    }
    const deadline = addDays(c.createdAt.slice(0, 10), c.timeLimitDays);
    if (deadline <= today) { out.push(`#${c.id} ${sym}: listed after its time limit`); continue; }
    await store.insertTrack({ cardId: c.id, symbol: sym, sectorEtf: SECTORS[c.sector as Sector] ?? "SPY", direction: c.direction, cardDate: today, deadlineDate: deadline });
    await store.addTrackEvent(c.id, "tracked_from_listing", `${sym} first traded ${bars[0].date}; seen listed ${today}. Paper track enters at the next open after that, not at a past price; deadline stays ${deadline}.`);
    out.push(`#${c.id} ${sym}: now tracked (listed ${bars[0].date})`);
  }
  return `listing watch: ${out.join(" · ")}`;
}
