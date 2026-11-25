/**
 * The one-sentence thesis shown at the top of a card. New cards carry it in the card itself (written in the same
 * reply as the rest of the card, logged with it and never changed). Older cards: the sentence written for them
 * earlier (card_theses, display only), else one built from the card's own fields. Nothing here rewrites a thesis.
 */
import { query as q } from "../db";
import type * as store from "./store";

/** Pure: a thesis from the card's fields, for cards whose sentence isn't written yet. */
export function fallbackThesis(c: Pick<store.StoredCard, "direction" | "primaryTicker" | "card">): string {
  const k = c.card;
  const own = /\bThe thesis(?: is)?:\s*([^]*?[.!?])(?:\s|$)/i.exec(`${k.observation} ${k.why_not_priced}`)?.[1];
  const why = own ? own.replace(/\.$/, "") : k.title.replace(/\.$/, "");
  // Whole sentences only: the catalyst by its date (its full text is on the card), never cut off mid-word.
  const date = k.catalyst?.date && /^\d{4}-\d{2}-\d{2}$/.test(k.catalyst.date)
    ? new Date(`${k.catalyst.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
  return `${c.direction === "long" ? "Long" : "Short"} ${c.primaryTicker}: ${why}.${date ? ` Catalyst about ${date};` : ""} ${k.time_limit_days}-day time limit.`;
}

export async function cardTheses(ids?: number[]): Promise<Map<number, string>> {
  const rows = await q(`SELECT card_id, thesis FROM card_theses ${ids ? "WHERE card_id = ANY($1)" : ""}`, ids ? [ids] : []);
  return new Map(rows.map((r) => [Number(r.card_id), String(r.thesis)]));
}

/**
 * Pure: a thesis as shown. Some cards open a one-sided idea as if it were a pair ("Long nothing; Short PLXS: ...",
 * "Short nothing, Long X: ..."): the empty half is left out on screen. The logged card is not changed.
 */
export function tidyThesis(t: string): string {
  const cut = t.replace(/^\s*(?:long|short)\s+(?:nothing|none|n\/a)\s*[;,.:–—-]\s*/i, "");
  // Only what was cut is tidied: any other thesis is shown exactly as written.
  return cut === t ? t : cut.replace(/^([a-z])/, (m) => m.toUpperCase());
}

/** Pure: the thesis to show: the card's own, else the one written for it earlier, else one built from its fields. */
export function thesisFor(c: Pick<store.StoredCard, "direction" | "primaryTicker" | "card">, written?: string): string {
  return tidyThesis(c.card.thesis?.trim() || written || fallbackThesis(c));
}
