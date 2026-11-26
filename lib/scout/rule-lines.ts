/**
 * The scout's mechanical rules, scored on their own lines. A rule needs no model to decide the trade ("short every
 * Drift setup the moment it lists, cover in 28 days"); it is what could one day be traded by fixed rules. Each has
 * its own paper book. Beside the down-drift rule, the model's picks are compared with the setups it passed on: if the
 * picks do no better than the passes, the model's judgment adds nothing to the plain rule there.
 *
 * Points are dollars against SPY on the same $1,000 stake as the cards (these books keep no sector fund).
 */
import { STAKE, trimmedMean } from "./scoreboard";

export interface RuleResult { vsSpy: number | null; closed: boolean }
export interface RuleLine { rule: string; about: string; side: "long" | "short"; trades: number; open: number; closed: number; wins: number; hitRate: number | null; median: number | null; trimmed: number | null; banked: number; inPlay: number }

/** Pure: one rule's line from its trades' results against SPY (fractions; null before entry or with no SPY price). */
export function ruleLine(rule: string, about: string, side: "long" | "short", results: RuleResult[]): RuleLine {
  const pts = (r: RuleResult) => Math.round(r.vsSpy! * STAKE);
  const have = results.filter((r) => r.vsSpy !== null);
  const closed = have.filter((r) => r.closed).map(pts), open = have.filter((r) => !r.closed).map(pts);
  const s = closed.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  const wins = closed.filter((x) => x > 0).length;
  return {
    rule, about, side, trades: results.length, open: results.filter((r) => !r.closed).length, closed: closed.length, wins, hitRate: closed.length ? wins / closed.length : null,
    median: s.length ? Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null, trimmed: trimmedMean(closed), banked: closed.reduce((a, b) => a + b, 0), inPlay: open.reduce((a, b) => a + b, 0),
  };
}

/**
 * Pure: was a Drift setup picked by the model? A down-drift card on the same stock, written from two days before
 * the setup listed to fourteen days after it.
 */
export function pickedByModel(e: { symbol: string; listedAt: string }, driftCards: Array<{ symbol: string; createdAt: string }>): boolean {
  const t = Date.parse(e.listedAt);
  return driftCards.some((c) => c.symbol === e.symbol && Date.parse(c.createdAt) >= t - 2 * 86400_000 && Date.parse(c.createdAt) <= t + 14 * 86400_000);
}
