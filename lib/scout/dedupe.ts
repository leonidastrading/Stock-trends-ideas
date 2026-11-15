/**
 * One card per stock and direction per player: a second card on the same call (say two angles on PRE from one
 * pasted article) would count the same bet twice on the Scoreboard. The story desk and the options desk are left
 * out: the story desk re-researches a story as it moves through stages, and options flags have their own limit.
 */
import { normalizeTicker } from "./tickers";
import { playerOf, type Player } from "./scoreboard";
import type { Candidate, StoredCard, Track } from "./store";
import type { ImportItem } from "./importer";

export const DUPLICATE_DAYS = 14;
const EXEMPT: Player[] = ["scout_story", "scout_options"];

export interface Existing { cardId: number; createdAt: string; symbol: string; direction: "long" | "short"; player: Player }

/** Pure: recent cards with their player, leaving out cards excluded from scoring (they followed the wrong security). */
export function existingCalls(cards: StoredCard[], candidates: Candidate[], tracks: Track[]): Existing[] {
  const termOf = new Map(candidates.filter((c) => c.cardId !== null).map((c) => [c.cardId!, c.term]));
  const excluded = new Set(tracks.filter((t) => t.excluded).map((t) => t.cardId));
  return cards.filter((c) => !excluded.has(c.id)).map((c) => ({ cardId: c.id, createdAt: c.createdAt, symbol: c.primaryTicker, direction: c.direction, player: playerOf(c.origin, termOf.get(c.id)) }));
}

/** Pure: the earlier card that makes this call a repeat, if any. Without a direction yet, any card on the stock counts. */
export function duplicateOf(existing: Existing[], call: { origin: "scout" | "human"; term: string; symbol: string | undefined; direction?: "long" | "short" }): Existing | null {
  if (!call.symbol) return null;
  const player = playerOf(call.origin, call.term);
  if (EXEMPT.includes(player)) return null;
  const sym = normalizeTicker(call.symbol) ?? call.symbol.toUpperCase();
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
