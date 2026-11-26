/**
 * What may sit on the watch-list, and its upkeep.
 *
 * A term is a searchable phrase of one to four words that a person would type: a brand, a product, an app, a theme
 * ("GLP-1 weight loss", "robotaxi"). The scan measures each term on every source every day, so the list has to stay
 * short enough to finish and each term has to be something the sources can measure. By November 2026 the list had
 * filled with card titles ("Three OPAL Fuels insiders buy shares again after a 55% fall"), which no one searches for;
 * the scan never finished and the YouTube quota was spent on them.
 *
 * - Nothing is approved automatically: the scout's proposals wait for the user.
 * - A card's title is never made a term.
 * - The scout's terms longer than four words, or made from a card, are retired. Seed terms and the user's own stay.
 * - At most 60 active terms: beyond that the scout's oldest retire.
 */
import type { WatchItem } from "./store";

export const WATCH = { maxWords: 4, maxActive: 60, maxChars: 40, staleDays: 30 };

export const termWords = (term: string) => term.trim().split(/\s+/).filter(Boolean).length;

/** Pure: why a phrase cannot be a watch-list term, or null when it can. */
export function termProblem(term: string): string | null {
  const t = term.trim();
  if (t.length < 2) return "too short";
  if (termWords(t) > WATCH.maxWords) return `more than ${WATCH.maxWords} words: a term is a phrase a person would search for (a brand, product, app or theme), not a headline`;
  if (t.length > WATCH.maxChars) return `longer than ${WATCH.maxChars} characters`;
  if (/[:;?!→]|\.\s|\.$/.test(t)) return "reads like a sentence or a desk label, not a search phrase";
  return null;
}

export interface UpkeepPlan { retire: Array<{ id: number; term: string; why: string }>; before: { active: number; proposed: number }; after: { active: number; proposed: number } }

/**
 * Pure: which terms to retire. `fromCard` are terms known to be a card's title (lower case). `stale` are the scout's
 * active terms that are over 30 days old and produced no card in that time. Seed terms and the user's are never touched.
 */
export function upkeepPlan(items: WatchItem[], fromCard: Set<string>, stale: Set<number> = new Set()): UpkeepPlan {
  const live = items.filter((i) => i.status !== "retired");
  const mine = (i: WatchItem) => i.addedBy === "scout";
  const retire: UpkeepPlan["retire"] = [];
  for (const i of live.filter(mine)) {
    if (termWords(i.term) > WATCH.maxWords) retire.push({ id: i.id, term: i.term, why: "longer than four words" });
    else if (fromCard.has(i.term.toLowerCase()) || /^from (?:a |human-originated )?card\b/i.test(i.note ?? "")) retire.push({ id: i.id, term: i.term, why: "made from a card's title" });
    else if (i.status === "active" && stale.has(i.id)) retire.push({ id: i.id, term: i.term, why: "quiet for 30 days" });
  }
  const gone = new Set(retire.map((r) => r.id));
  const active = live.filter((i) => i.status === "active" && !gone.has(i.id));
  // Over the cap: the scout's oldest go first; the user's and the seed terms always stay.
  const extra = active.length - WATCH.maxActive;
  if (extra > 0) for (const i of active.filter(mine).sort((a, b) => a.addedAt.localeCompare(b.addedAt)).slice(0, extra)) { retire.push({ id: i.id, term: i.term, why: `over the cap of ${WATCH.maxActive} active terms` }); gone.add(i.id); }
  const count = (s: WatchItem["status"], kept: boolean) => live.filter((i) => i.status === s && (!kept || !gone.has(i.id))).length;
  return { retire, before: { active: count("active", false), proposed: count("proposed", false) }, after: { active: count("active", true), proposed: count("proposed", true) } };
}
