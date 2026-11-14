/** Upcoming catalysts across tracked cards, and conflicting calls on the same ticker. Pure. */
import type { StoredCard, Track } from "./store";

export interface Upcoming { date: string; cardId: number; ticker: string; direction: "long" | "short"; what: string; title: string }

/** Catalysts dated today or later on cards whose paper track is still open (or not yet entered), soonest first. */
export function upcomingCatalysts(cards: StoredCard[], tracks: Track[], today: string, days = 21): Upcoming[] {
  const open = new Set(tracks.filter((t) => !t.exitDate).map((t) => t.cardId));
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return cards
    .filter((c) => c.catalystDate && c.catalystDate >= today && c.catalystDate <= end && open.has(c.id))
    .map((c) => ({ date: c.catalystDate!, cardId: c.id, ticker: c.primaryTicker, direction: c.direction, what: c.card.catalyst.what, title: c.card.title }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
}

/** For each open card, the other open cards on the same ticker with the opposite direction. */
export function opposingCalls(cards: StoredCard[], tracks: Track[]): Map<number, number[]> {
  const open = new Set(tracks.filter((t) => !t.exitDate).map((t) => t.cardId));
  const live = cards.filter((c) => open.has(c.id));
  const out = new Map<number, number[]>();
  for (const c of live) {
    const other = live.filter((o) => o.id !== c.id && o.primaryTicker === c.primaryTicker && o.direction !== c.direction).map((o) => o.id);
    if (other.length) out.set(c.id, other);
  }
  return out;
}
