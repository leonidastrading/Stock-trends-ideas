/**
 * A new card must not name, as a related ticker, a stock the scout already has an open paper call on in the other
 * direction (card #223 listed AAOI as a long beneficiary while #212 and #279 were short AAOI). Research is told the
 * open calls up front, and anything that still slips through is dropped from the card before it is logged, with a
 * gate note. The card's own (tracked) ticker is never dropped: a deliberate opposite call is allowed and shows as
 * "opposing" on both cards.
 */
import type { Card } from "./card";
import type { Track } from "./store";

export interface OpenCall { symbol: string; direction: "long" | "short"; cardId: number }

/** Pure: open paper calls (entered or waiting, not closed, invalidated or excluded). */
export function openCalls(tracks: Track[]): OpenCall[] {
  return tracks.filter((t) => !t.exitDate && !t.invalidatedAt && !t.excluded).map((t) => ({ symbol: t.symbol, direction: t.direction, cardId: t.cardId }));
}

/** Pure: the open calls as a short list for the research prompt. */
export function openCallsText(calls: OpenCall[], max = 120): string | null {
  if (!calls.length) return null;
  const by = new Map<string, { long: number[]; short: number[] }>();
  for (const c of calls) { const e = by.get(c.symbol) ?? { long: [], short: [] }; e[c.direction].push(c.cardId); by.set(c.symbol, e); }
  const items = [...by].sort((a, b) => a[0].localeCompare(b[0])).slice(0, max).map(([s, e]) => [e.long.length ? `${s} long (#${e.long.join(", #")})` : "", e.short.length ? `${s} short (#${e.short.join(", #")})` : ""].filter(Boolean).join(", "));
  return `THE SCOUT'S OPEN PAPER CALLS: ${items.join("; ")}.\nNever list as a related (second or later) ticker a stock that has an open call in the other direction to this card: it would recommend both sides. If the idea really cuts against an open call, say so in the risks instead, or make it this card's own ticker deliberately.`;
}

/** Pure: the card without related tickers that contradict an open call, and a note for each one dropped. */
export function dropContradictions(card: Card, calls: OpenCall[]): { card: Card; notes: string[] } {
  const notes: string[] = [];
  const keep = card.tickers.filter((t, i) => {
    if (i === 0) return true;
    const against = calls.filter((c) => c.symbol === t.symbol.toUpperCase() && c.direction !== card.direction);
    if (!against.length) return true;
    notes.push(`left out ${t.symbol} as a related ticker: the scout's open ${against[0].direction} call${against.length > 1 ? "s" : ""} ${against.map((c) => `#${c.cardId}`).join(", ")} on it point${against.length > 1 ? "" : "s"} the other way`);
    return false;
  });
  return { card: notes.length ? { ...card, tickers: keep } : card, notes };
}
