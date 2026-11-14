/**
 * Staleness (Tetlock 2011): how much today's headlines on a ticker repeat its
 * earlier stories. Re-reported news, recaps and "why X is moving" pieces are
 * overtraded by retail investors and tend to reverse; new facts drift.
 * Measured as, for each of today's headlines, the highest word overlap
 * (Jaccard) with any of the ticker's previous stories, averaged.
 */
const STOP = new Set("the a an and or of to in on for with at by from as is are was were be been it its this that these those after before over under into about amid says said say stock stocks shares share why what how here you your new news update updates today week inc corp co ltd plc".split(" "));

export function headlineWords(h: string): Set<string> {
  return new Set(h.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Pure: 0 = all new, 1 = all repeated. Null without earlier stories to compare with. */
export function staleness(today: string[], earlier: string[]): number | null {
  const prev = earlier.slice(0, 10).map(headlineWords).filter((s) => s.size);
  const now = today.map(headlineWords).filter((s) => s.size);
  if (!prev.length || !now.length) return null;
  const scores = now.map((w) => Math.max(...prev.map((p) => jaccard(w, p))));
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
}

export const STALE_FROM = 0.45;

export function stalenessLabel(x: number | null): string {
  if (x === null) return "staleness unknown (no earlier stories to compare)";
  return `staleness ${x.toFixed(2)} (${x >= STALE_FROM ? "today's headlines mostly repeat earlier stories: stale" : x >= 0.25 ? "partly repeats earlier stories" : "new"})`;
}
