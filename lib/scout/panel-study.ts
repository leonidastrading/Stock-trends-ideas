/**
 * The panel-vote study: does trading WITH the FDA's advisory panel pay, once its vote is public?
 *
 * Before deciding on a drug the FDA often asks a panel of outside experts to vote. The vote is public the same day,
 * the decision follows weeks to months later, and the FDA usually (not always) follows the panel. The question the
 * CAPR card (#268) raised: after a negative vote the crowd is often still hopeful, so is there money left in being
 * short from the day after the vote until the decision, and the mirror case, long after a positive vote?
 *
 * The votes (config/panel-votes.ts) were read from companies' own 8-K press releases on SEC EDGAR; each decision is
 * the company's own later announcement (an approval, or a "complete response letter", which is a rejection). Prices
 * are Alpaca daily bars from December 2018, so votes before 2019 are listed but not priced. Every return is "with
 * the panel" (long after a positive vote, short after a negative one), from the next day's open after the vote was
 * public, and against the biotech ETF XBI, in percent.
 *
 * This is a look at history with fixed rules, not a replay of the scout's model, and the sample is small: read the
 * count before the average.
 */
import { PANEL_VOTES, PANEL_VOTES_REVISION, type PanelVote } from "@/config/panel-votes";
import type { DailyBar, MarketData } from "../alpaca";
import { toEt } from "../time";
import { stat, type Stat } from "./rating-study";
import * as store from "./store";

export const PANEL_STUDY = { barsStart: "2018-12-01", bench: "XBI", horizons: [20, 60] as const, chunk: 20, key: "panel-study", redoDays: 7, budgetMs: 200_000 };

export interface PanelResult {
  symbol: string; company: string; public: string; side: PanelVote["side"]; yes: number; no: number; url: string;
  outcome: "approved" | "rejected" | null; decisionDate: string | null;
  /** The first trading day after the vote was public (the entry, at its open). */
  entryDate: string | null;
  /** The stock's own move from the close before the vote to the entry's open: what the market took at once (not vs XBI, not signed). */
  reactionPct: number | null;
  /** With the panel, vs XBI, from the entry's open to the close 20 and 60 trading days later. */
  h20: number | null; h60: number | null;
  /** With the panel, vs XBI, from the entry's open to the close of the trading day after the decision was announced. */
  toDecision: number | null; daysToDecision: number | null;
}

/** Pure: one vote's returns from its stock's daily bars and the benchmark's (both oldest first). */
export function panelReturns(v: PanelVote, bars: DailyBar[], bench: DailyBar[]): PanelResult {
  const out: PanelResult = { symbol: v.symbol, company: v.company, public: v.public, side: v.side, yes: v.yes, no: v.no, url: v.url, outcome: v.decision?.outcome ?? null, decisionDate: v.decision?.date ?? null, entryDate: null, reactionPct: null, h20: null, h60: null, toDecision: null, daysToDecision: null };
  const i = bars.findIndex((b) => b.date > v.public);
  if (i < 1) return out;
  const entry = bars[i];
  const benchAt = new Map(bench.map((b) => [b.date, b]));
  const be = benchAt.get(entry.date);
  if (!be || !(entry.o > 0) || !(be.o > 0)) return out;
  const sign = v.side === "positive" ? 1 : -1;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const withPanel = (exit: DailyBar | undefined): number | null => {
    const bx = exit ? benchAt.get(exit.date) : undefined;
    return exit && bx ? r2(sign * ((exit.c / entry.o - 1) - (bx.c / be.o - 1)) * 100) : null;
  };
  out.entryDate = entry.date;
  // The close before the vote was public: the last bar before the filing day (the filing day itself may hold the move).
  const before = bars.filter((b) => b.date < v.public).at(-1);
  out.reactionPct = before && before.c > 0 ? r2((entry.o / before.c - 1) * 100) : null;
  out.h20 = withPanel(bars[i + 20]);
  out.h60 = withPanel(bars[i + 60]);
  if (v.decision) {
    // The close of the first trading day AFTER the announcement: decisions often come after the bell, so that day holds the reaction either way.
    const j = bars.findIndex((b) => b.date > v.decision!.date);
    if (j > i) { out.toDecision = withPanel(bars[j]); out.daysToDecision = j - i; }
  }
  return out;
}

export interface PanelRow { side: PanelVote["side"]; votes: number; priced: number; approved: number; rejected: number; undecided: number; reaction: Stat; h20: Stat; h60: Stat; toDecision: Stat; winToDecision: number | null }

/** Pure: the table, one row per side of the vote. `winToDecision` is the share of trades with the panel that beat XBI. */
export function panelTable(results: PanelResult[]): PanelRow[] {
  return (["negative", "positive"] as const).map((side) => {
    const rs = results.filter((r) => r.side === side);
    const dec = rs.map((r) => r.toDecision).filter((x): x is number => x !== null);
    return {
      side, votes: rs.length, priced: rs.filter((r) => r.entryDate).length,
      approved: rs.filter((r) => r.outcome === "approved").length, rejected: rs.filter((r) => r.outcome === "rejected").length, undecided: rs.filter((r) => !r.outcome).length,
      reaction: stat(rs.map((r) => r.reactionPct)), h20: stat(rs.map((r) => r.h20)), h60: stat(rs.map((r) => r.h60)), toDecision: stat(dec),
      winToDecision: dec.length ? Math.round((dec.filter((x) => x > 0).length / dec.length) * 100) : null,
    };
  });
}

export interface PanelStudyState { rev: number; at: string; results: PanelResult[]; noPrices: string[]; partial: boolean }

const pct = (s: Stat) => (s.mean === null ? "n/a" : `${s.mean > 0 ? "+" : ""}${s.mean}% avg, ${s.median! > 0 ? "+" : ""}${s.median}% median, n=${s.n}`);

/** Pure: the table in one line (the job's log, and the note on the Pharma tab). */
export function panelLine(rows: PanelRow[]): string {
  return rows.map((r) => `${r.side} votes ${r.votes} (${r.rejected} rejected, ${r.approved} approved, ${r.undecided} no decision found; ${r.priced} priced): with the panel to the decision ${pct(r.toDecision)}${r.winToDecision === null ? "" : `, ${r.winToDecision}% beat XBI`}; 20 days ${pct(r.h20)}; 60 days ${pct(r.h60)}; first reaction ${pct(r.reaction)}`).join(" | ");
}

/** The saved study, or null before its first run. */
export async function panelStudy(): Promise<PanelStudyState | null> {
  return (await store.cacheGet<PanelStudyState>(PANEL_STUDY.key).catch(() => null))?.data ?? null;
}

/** Price every vote (about a minute); done again weekly so recent votes get their later returns, and when the list changes. */
export async function runPanelStudy(data: MarketData | null, now = new Date(), votes: PanelVote[] = PANEL_VOTES, rev = PANEL_VOTES_REVISION): Promise<string> {
  if (!data) return "panel study: waiting for market data (Alpaca keys)";
  const prev = await store.cacheGet<PanelStudyState>(PANEL_STUDY.key).catch(() => null);
  if (prev?.data && prev.data.rev === rev && !prev.data.partial && now.getTime() - Date.parse(prev.data.at) < PANEL_STUDY.redoDays * 86400_000) return "panel study: done";
  const started = Date.now();
  const today = toEt(now).date;
  const opts = { feed: "sip" as const, adjustment: "all" as const };
  const bench = (await data.getDailyBars([PANEL_STUDY.bench], PANEL_STUDY.barsStart, today, opts)).sort((a, b) => a.date.localeCompare(b.date));
  if (!bench.length) return "panel study: no benchmark prices yet";
  const symbols = [...new Set(votes.filter((v) => v.public >= PANEL_STUDY.barsStart).map((v) => v.symbol))];
  const bySymbol = new Map<string, DailyBar[]>();
  let partial = false;
  for (let i = 0; i < symbols.length; i += PANEL_STUDY.chunk) {
    if (Date.now() - started > PANEL_STUDY.budgetMs) { partial = true; break; }
    const got = await data.getDailyBars(symbols.slice(i, i + PANEL_STUDY.chunk), PANEL_STUDY.barsStart, today, opts).catch(() => [] as DailyBar[]);
    for (const b of got) bySymbol.set(b.symbol, [...(bySymbol.get(b.symbol) ?? []), b]);
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const results = votes.map((v) => panelReturns(v, bySymbol.get(v.symbol) ?? [], bench));
  const noPrices = [...new Set(results.filter((r) => !r.entryDate).map((r) => r.symbol))];
  await store.cachePut(PANEL_STUDY.key, { rev, at: now.toISOString(), results, noPrices, partial } satisfies PanelStudyState);
  return `panel study: ${panelLine(panelTable(results))}${partial ? " · out of time, finishing next run" : ""}`;
}
