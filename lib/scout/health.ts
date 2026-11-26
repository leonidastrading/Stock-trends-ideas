/**
 * Health of every outside source a page relies on, on one panel (Settings) and on Home when one is not reporting.
 *
 * The panel used to list only the trend desk's ten search sources, so a dead feed elsewhere was invisible: Positioning
 * showed no dealer-gamma estimate for SPY, QQQ or IWM and nothing said the Cboe option chains were failing. Now each
 * reader reports here when it runs: ok, or down with the reason. A source that has not reported for longer than it
 * should is "stale". Each background job reports too, so a page fed by a job that stopped is flagged.
 */
import { JOBS } from "./jobs";
import * as store from "./store";

/** Sources and jobs watched beyond the trend desk's own: a label, what relies on it, and how long it may go without reporting. */
export const WATCHED: Record<string, { label: string; about: string; staleHours: number }> = {
  cboe_options: { label: "Cboe option chains", about: "Dealer gamma, open interest and the options readings on Positioning and on cards", staleHours: 80 },
  market_prices: { label: "Prices (Alpaca)", about: "Every paper entry, mark and chart", staleHours: 80 },
  news_stream: { label: "News stream (Alpaca)", about: "The News tab, the story desk, Drift and Upgrades", staleHours: 20 },
  wire_globenewswire: { label: "GlobeNewswire feed", about: "Press releases the minute they are out (News, press-release desk)", staleHours: 20 },
  wire_prnewswire: { label: "PR Newswire feed", about: "Press releases the minute they are out (News, press-release desk)", staleHours: 20 },
  sec_live_8k: { label: "SEC live 8-K list", about: "Filings read the moment they are public (News, story desk)", staleHours: 80 },
  nasdaq_halts: { label: "Nasdaq trading halts", about: "Halts in the News tab and alerts", staleHours: 80 },
  ...Object.fromEntries(Object.entries(JOBS).filter(([n]) => !["ratingstudy", "panelstudy", "evidence", "listings", "earningsrepair"].includes(n)).map(([n, j]) => [`job:${n}`, { label: `Job: ${n}`, about: j.about, staleHours: Math.max(16, (j.everyMin / 60) * 3 + 14) }])),
};

const last = new Map<string, { status: string; at: number }>();

/** Record a source's state. Best effort and cheap: written when the state changes, else at most every 15 minutes. */
export async function reportHealth(source: string, ok: boolean, detail?: string | null): Promise<void> {
  const status = ok ? "ok" : "down";
  const prev = last.get(source);
  if (prev && prev.status === status && Date.now() - prev.at < 15 * 60000) return;
  last.set(source, { status, at: Date.now() });
  await store.saveHealth(source, status, detail ? detail.slice(0, 300) : null).catch(() => undefined);
}

/** Pure: does a job's own result line say it failed? (Jobs catch their errors and say so in words.) */
export const saysFailed = (result: string) => /\b(failed|could not|unreachable|timed out|HTTP [45]\d\d)\b/i.test(result) && !/\b0 failed\b/i.test(result);

export interface HealthRow { source: string; label: string; about: string; status: "ok" | "down" | "missing" | "stale" | "capped" | "not checked yet"; detail: string | null; checkedAt: string | null }

/** Pure: the watched sources with their state now; one that has gone quiet for too long is stale. */
export function watchedHealth(rows: store.Health[], now: Date): HealthRow[] {
  const by = new Map(rows.map((r) => [r.source, r]));
  return Object.entries(WATCHED).map(([source, w]) => {
    const r = by.get(source);
    if (!r) return { source, label: w.label, about: w.about, status: "not checked yet" as const, detail: null, checkedAt: null };
    const quiet = now.getTime() - Date.parse(r.checkedAt) > w.staleHours * 3600_000;
    return { source, label: w.label, about: w.about, status: quiet ? ("stale" as const) : (r.status as HealthRow["status"]), detail: quiet ? `has not reported since then (expected within ${Math.round(w.staleHours)} hours)` : r.detail, checkedAt: r.checkedAt };
  });
}

/** Pure: every source that is not reporting, by name, for Home: the trend desk's own and the watched ones. */
export function notReporting(rows: store.Health[], now: Date, labelOf: (source: string) => string = (s) => s): string[] {
  const watched = watchedHealth(rows, now);
  const mine = new Set(Object.keys(WATCHED));
  const out = rows.filter((r) => !mine.has(r.source) && !r.source.startsWith("job:") && (r.status === "down" || r.status === "missing")).map((r) => `${labelOf(r.source)} (${r.status})`);
  return [...out, ...watched.filter((w) => w.status === "down" || w.status === "stale").map((w) => `${w.label} (${w.status})`)];
}
