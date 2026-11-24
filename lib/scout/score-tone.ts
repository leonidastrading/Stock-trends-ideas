/**
 * The colour of a card's score: green (high), amber (middle) or red (low). Higher is better for every score.
 * The bands are the Ideas page's own filter bands, so a colour and a filter always agree: under 50, 50 to 69, 70 and
 * up; rank (novelty x materiality, so naturally lower) under 30, 30 to 49, 50 and up.
 */
export type Tone = "pos" | "warn" | "neg";

/** Pure: a score (in % as shown on the card) to its colour class. */
export function scoreTone(pct: number, kind: "score" | "rank" = "score"): Tone {
  const [mid, high] = kind === "rank" ? [30, 50] : [50, 70];
  return pct >= high ? "pos" : pct >= mid ? "warn" : "neg";
}
