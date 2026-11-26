/**
 * One card per stock and direction per player: a second card on the same call (say two angles on PRE from one
 * pasted article) would count the same bet twice on the Scoreboard. The options desk is left out (its flags have
 * their own limit). The story desk cards a story again when it reaches a new stage; short of that (a story that is
 * only building, or read again), it may not repeat the same side of the same stock within a few days.
 */
import { normalizeTicker } from "./tickers";
import { playerOf, type Player } from "./scoreboard";
import type { Candidate, StoredCard, Track } from "./store";
import type { ImportItem } from "./importer";

export const DUPLICATE_DAYS = 14;
const EXEMPT: Player[] = ["scout_story", "scout_options"];
/** Short of a new stage, the story desk may not card the same side of the same stock again within these days (NTNX: #423 in the evening, #448 the next morning, nothing new between them). */
export const STORY_REPEAT_DAYS = 5;

export interface Existing { cardId: number; createdAt: string; symbol: string; direction: "long" | "short"; player: Player }

/** Pure: recent cards with their player, leaving out cards excluded from scoring (they followed the wrong security). */
export function existingCalls(cards: StoredCard[], candidates: Candidate[], tracks: Track[]): Existing[] {
  const termOf = new Map(candidates.filter((c) => c.cardId !== null).map((c) => [c.cardId!, c.term]));
  const excluded = new Set(tracks.filter((t) => t.excluded).map((t) => t.cardId));
  return cards.filter((c) => !excluded.has(c.id)).map((c) => ({ cardId: c.id, createdAt: c.createdAt, symbol: c.primaryTicker, direction: c.direction, player: playerOf(c.origin, termOf.get(c.id)) }));
}

/** Pure: the earlier card that makes this call a repeat, if any. Without a direction yet, any card on the stock counts. */
export function duplicateOf(existing: Existing[], call: { origin: "scout" | "human"; term: string; symbol: string | undefined; direction?: "long" | "short"; now?: Date }): Existing | null {
  if (!call.symbol) return null;
  const player = playerOf(call.origin, call.term);
  const sym = normalizeTicker(call.symbol) ?? call.symbol.toUpperCase();
  if (player === "scout_story") {
    // Same stock, same side, a few days apart: the same bet twice. A different side, or a later stage, is a new card.
    // A new stage (an institution acted in a headline the desk had not read) is a new card, as it always was.
    if (!call.direction || /\(stage \d+\)/.test(call.term)) return null;
    const since = (call.now ?? new Date()).getTime() - STORY_REPEAT_DAYS * 86400_000;
    return existing.find((e) => e.player === player && e.symbol === sym && e.direction === call.direction && Date.parse(e.createdAt) >= since) ?? null;
  }
  if (EXEMPT.includes(player)) return null;
  return existing.find((e) => e.player === player && e.symbol === sym && (!call.direction || e.direction === call.direction)) ?? null;
}

/** Pure: ideas in one document about the same stock and direction become one idea (the first one's term, both observations). */
export function mergeSameStock(items: ImportItem[]): ImportItem[] {
  const out: ImportItem[] = [];
  const key = (it: ImportItem) => {
    const t = it.tickers.map(normalizeTicker).find((x): x is string => !!x);
    return t ? `${t}:${it.direction ?? "any"}` : null;
  };
  for (const it of items) {
    const k = key(it);
    const same = k ? out.find((o) => key(o) === k || (key(o)?.split(":")[0] === k.split(":")[0] && (!o.direction || !it.direction))) : undefined;
    if (!same) { out.push({ ...it }); continue; }
    same.observation = `${same.observation} Also in the same document (${it.term}): ${it.observation}`.slice(0, 2000);
    same.tickers = [...new Set([...same.tickers, ...it.tickers])].slice(0, 8);
    same.direction = same.direction ?? it.direction;
    same.catalyst_date = same.catalyst_date || it.catalyst_date;
  }
  return out;
}

/**
 * Pure: cards that repeat an earlier call (same player, stock and direction within DUPLICATE_DAYS), mapped to the
 * card they repeat. Covers cards logged before the duplicate check existed; they stay on file but are shown under
 * the first card and left out of scoring, so one bet counts once.
 */
export function repeatCards(cards: Array<{ id: number; createdAt: string; origin: "scout" | "human"; primaryTicker: string; direction: "long" | "short" }>, termOf: Map<number, string>): Map<number, number> {
  const out = new Map<number, number>();
  const kept: Array<{ id: number; at: number; player: Player; symbol: string; direction: string }> = [];
  for (const c of cards.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)) {
    const player = playerOf(c.origin, termOf.get(c.id));
    const at = Date.parse(c.createdAt);
    const first = EXEMPT.includes(player) ? undefined : kept.find((k) => k.player === player && k.symbol === c.primaryTicker && k.direction === c.direction && at - k.at <= DUPLICATE_DAYS * 86400_000);
    if (first) out.set(c.id, first.id);
    else kept.push({ id: c.id, at, player, symbol: c.primaryTicker, direction: c.direction });
  }
  return out;
}
