/**
 * Scoreboard: the paper results as a game. Points are dollars beaten versus SPY
 * on a $1,000 paper stake per call (+3.2% excess = +32 points). "Banked" points
 * come from closed calls; "in play" points are open calls marked at the latest
 * close and can still change. Pure: inputs are the scoring page's idea results.
 *
 * Commentary only: the formal pass/fail verdict stays per version on Scoring.
 */
import type { IdeaResult } from "./scoring";

export const STAKE = 1000;
export const PLAYERS = ["scout_trend", "scout_story", "scout_options", "scout_filings", "scout_truth", "scout_sites", "scout_drift", "scout_downgrade", "scout_rumors", "scout_investigations", "scout_themes", "scout_filing_changes", "scout_readthrough", "you", "stream_host", "stream_agent", "inbox_bot"] as const;
export type Player = (typeof PLAYERS)[number];
export const PLAYER_LABEL: Record<Player, string> = {
  scout_trend: "Scout · trend desk",
  scout_story: "Scout · story desk",
  scout_options: "Scout · options positioning",
  scout_filings: "Scout · insiders, filings & Congress",
  scout_truth: "Scout · Trump posts",
  scout_sites: "Scout · your websites",
  scout_drift: "Scout · down drift",
  scout_downgrade: "Scout · downgrade drift",
  scout_rumors: "Scout · rumors (checked)",
  scout_themes: "Scout · themes (consensus)",
  scout_investigations: "Scout · investigations",
  scout_filing_changes: "Scout · filing changes",
  scout_readthrough: "Scout · supply-chain read-through",
  you: "You",
  stream_host: "Stream file · host",
  stream_agent: "Stream file · agent",
  inbox_bot: "Your bot (GitHub inbox)",
};

/** Who made the call: by origin, and by the candidate term the card came from. */
export function playerOf(origin: "scout" | "human", term: string | undefined): Player {
  const t = (term ?? "").toLowerCase();
  if (origin === "scout" && t.startsWith("filing change:")) return "scout_filing_changes";
  if (origin === "scout" && t.startsWith("readthrough:")) return "scout_readthrough";
  if (origin === "scout") return t.startsWith("story:") ? "scout_story" : t.startsWith("options:") ? "scout_options" : /^(filing|insider|congress|insider\+congress): /.test(t) ? "scout_filings" : t.startsWith("truth:") ? "scout_truth" : t.startsWith("site:") ? "scout_sites" : t.startsWith("drift:") ? (/\bdowngrade\b/.test(t) ? "scout_downgrade" : "scout_drift") : t.startsWith("rumor:") ? "scout_rumors" : t.startsWith("investigate:") ? "scout_investigations" : t.startsWith("theme:") ? "scout_themes" : "scout_trend";
  if (t.startsWith("stream host:")) return "stream_host";
  if (t.startsWith("stream agent:")) return "stream_agent";
  if (t.startsWith("inbox:")) return "inbox_bot";
  return "you";
}

export interface Round extends IdeaResult {
  player: Player; points: number | null; win: boolean | null; confidence: number | null; calibrated: boolean;
  /** The same stake measured against the card's sector fund: was it the company, or just its industry? */
  sectorPoints: number | null;
  /** The scout version that wrote the card. */
  versionId?: number;
  /** Set for a call from a desk that is study-only for now (kept off the leaderboard), with the reason. */
  study?: string | null;
}

export function toRound(i: IdeaResult, player: Player, confidence: number | null, calibrated: boolean, extra: { versionId?: number; term?: string } = {}): Round {
  const points = i.excess === null ? null : Math.round(i.excess * STAKE);
  return { ...i, player, points, win: i.excess === null ? null : i.excess > 0, confidence, calibrated, sectorPoints: i.excessSector === null ? null : Math.round(i.excessSector * STAKE), versionId: extra.versionId, study: studyReason(player, extra.term) };
}

/**
 * Desks that are study-only for now: their calls are still tracked and shown, on their own table, but stay off the
 * leaderboard until the desk's known flaw is fixed and it has results under the fixed rule.
 */
export const STUDY_ONLY: Partial<Record<Player, string>> = {
  scout_rumors: "a claim was logged as a rumor even when the mainstream press had already reported it",
  scout_themes: "the same theme was scored again every time it repeated",
};
/** Pure: why this call is study-only (a study-only desk, or a Congress-cluster call inside the filings desk), or null. */
export function studyReason(player: Player, term?: string): string | null {
  if (STUDY_ONLY[player]) return STUDY_ONLY[player]!;
  if (player === "scout_filings" && /^congress:/i.test((term ?? "").trim())) return "clusters were built from small trades reported months late";
  return null;
}

/** The headline number for a call: points against its sector fund (against SPY for a card with no sector fund price). */
export const score = (r: Round): number | null => r.sectorPoints ?? r.points;

/** Calls by one player on the same stock, the same way, entered within this many days of the first are one story. */
export const STORY_DAYS = 10;

export interface Story { player: Player; symbol: string; direction: "long" | "short"; first: Round; calls: number; cardIds: number[] }

/**
 * Pure: the calls as stories. A player who calls the same stock the same way again within ten days is repeating one
 * idea, so the idea counts once, at its first call (the repeats are kept as the story's other cards). Without this
 * one story written up six times is six wins or six losses, and hit rates and luck checks mean nothing.
 */
export function storiesOf(rounds: Round[]): Story[] {
  const by = new Map<string, Round[]>();
  for (const r of rounds) { const k = `${r.player}|${r.symbol}|${r.direction}`; by.set(k, [...(by.get(k) ?? []), r]); }
  const out: Story[] = [];
  for (const list of by.values()) {
    let cur: Story | null = null;
    for (const r of list.slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.cardId - b.cardId)) {
      const days = cur ? (Date.parse(r.entryDate) - Date.parse(cur.first.entryDate)) / 86400_000 : Infinity;
      if (cur && days <= STORY_DAYS) { cur.calls++; cur.cardIds.push(r.cardId); continue; }
      cur = { player: r.player, symbol: r.symbol, direction: r.direction, first: r, calls: 1, cardIds: [r.cardId] };
      out.push(cur);
    }
  }
  return out;
}

const med = (xs: number[]) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2); return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
/** Pure: the mean with the best and the worst result taken out (needs three or more), so one outlier cannot carry a line. */
export function trimmedMean(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const s = xs.slice().sort((a, b) => a - b).slice(1, -1);
  return Math.round(s.reduce((a, b) => a + b, 0) / s.length);
}

export interface Line {
  player: Player; side: "long" | "short"; calls: number; stories: number; closed: number; open: number; wins: number; hitRate: number | null;
  /** Points against the sector fund per closed story: the middle one, and the mean without the best and worst. */
  median: number | null; trimmed: number | null; banked: number; inPlay: number; bankedSpy: number;
  luck: number | null; best: Round | null; worst: Round | null;
}

/**
 * Pure: the leaderboard, one line per player and side. Longs and shorts are apart so a falling market cannot be read
 * as skill at shorting (or a rising one as skill at buying). Every figure counts one result per story.
 */
export function boardLines(rounds: Round[]): Line[] {
  const stories = storiesOf(rounds.filter((r) => score(r) !== null));
  const lines: Line[] = [];
  for (const player of PLAYERS) for (const side of ["long", "short"] as const) {
    const mine = stories.filter((s) => s.player === player && s.direction === side);
    if (!mine.length) continue;
    const closed = mine.filter((s) => s.first.closed), open = mine.filter((s) => !s.first.closed);
    const pts = closed.map((s) => score(s.first)!);
    const wins = pts.filter((x) => x > 0).length;
    const ranked = closed.slice().sort((a, b) => score(b.first)! - score(a.first)!);
    lines.push({
      player, side, calls: mine.reduce((a, s) => a + s.calls, 0), stories: mine.length, closed: closed.length, open: open.length, wins, hitRate: closed.length ? wins / closed.length : null,
      median: med(pts), trimmed: trimmedMean(pts), banked: pts.reduce((a, b) => a + b, 0), inPlay: open.reduce((a, s) => a + score(s.first)!, 0), bankedSpy: closed.reduce((a, s) => a + (s.first.points ?? 0), 0),
      luck: closed.length ? coinTail(wins, closed.length) : null, best: ranked[0]?.first ?? null, worst: ranked.length > 1 ? ranked[ranked.length - 1].first : null,
    });
  }
  // Players by their closed points, long and short together; each player's two lines stay side by side.
  const total = (p: Player) => lines.filter((l) => l.player === p).reduce((a, l) => a + l.banked, 0);
  const open = (p: Player) => lines.filter((l) => l.player === p).reduce((a, l) => a + l.inPlay, 0);
  return lines.sort((a, b) => total(b.player) - total(a.player) || open(b.player) - open(a.player) || PLAYERS.indexOf(a.player) - PLAYERS.indexOf(b.player) || a.side.localeCompare(b.side));
}

export type VerdictGroup = "played out" | "did not play out" | "cannot tell" | "no check yet";
/** Pure: the post-catalyst verdict in the three words the scoreboard uses. */
export const verdictGroup = (v: string | null | undefined): VerdictGroup => (v === "played_out" ? "played out" : v === "did_not" ? "did not play out" : v ? "cannot tell" : "no check yet");

export interface VerdictRow { verdict: VerdictGroup; n: number; wins: number; hitRate: number | null; median: number | null }
/**
 * Pure: closed stories by what the thesis did. Points and the thesis can disagree (a short that made money while
 * its thesis "did not play out" was the market, not the idea), so the hit rate is shown for each.
 */
export function byVerdict(rounds: Round[], verdictOf: (cardId: number) => string | null | undefined): VerdictRow[] {
  const closed = storiesOf(rounds.filter((r) => score(r) !== null)).filter((s) => s.first.closed);
  return (["played out", "did not play out", "cannot tell", "no check yet"] as VerdictGroup[]).map((verdict) => {
    const mine = closed.filter((s) => verdictGroup(verdictOf(s.first.cardId)) === verdict).map((s) => score(s.first)!);
    const wins = mine.filter((x) => x > 0).length;
    return { verdict, n: mine.length, wins, hitRate: mine.length ? wins / mine.length : null, median: med(mine) };
  });
}

/** P(at least `wins` heads in `n` fair coin flips): how often pure luck does this well. */
export function coinTail(wins: number, n: number): number {
  if (n <= 0) return 1;
  let logC = 0; // log C(n, k), built up from k = 0
  let total = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    if (k >= wins) total += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, total);
}

export interface Standing {
  player: Player; calls: number; closed: number; open: number; wins: number; hitRate: number | null;
  banked: number; inPlay: number; bankedVsSector: number; best: Round | null; worst: Round | null;
  brier: number | null; brierN: number; luck: number | null;
}

/** Brier score of confidence (as a probability) against "beat SPY": 0 is perfect, 0.25 is always saying 50. */
export function brier(rounds: Round[]): { score: number | null; n: number } {
  const r = rounds.filter((x) => x.closed && x.win !== null && x.calibrated && x.confidence !== null);
  if (!r.length) return { score: null, n: 0 };
  return { score: r.reduce((a, x) => a + (x.confidence! / 100 - (x.win ? 1 : 0)) ** 2, 0) / r.length, n: r.length };
}

export function standings(rounds: Round[]): Standing[] {
  return PLAYERS.map((player) => {
    const mine = rounds.filter((r) => r.player === player);
    const closed = mine.filter((r) => r.closed && r.points !== null);
    const open = mine.filter((r) => !r.closed && r.points !== null);
    const wins = closed.filter((r) => r.win).length;
    const byPts = closed.slice().sort((a, b) => b.points! - a.points!);
    const b = brier(mine);
    return {
      player, calls: mine.length, closed: closed.length, open: open.length, wins,
      hitRate: closed.length ? wins / closed.length : null,
      banked: closed.reduce((a, r) => a + r.points!, 0), inPlay: open.reduce((a, r) => a + r.points!, 0),
      bankedVsSector: closed.reduce((a, r) => a + (r.sectorPoints ?? 0), 0),
      best: byPts[0] ?? null, worst: byPts.length > 1 ? byPts[byPts.length - 1] : null,
      brier: b.score, brierN: b.n, luck: closed.length ? coinTail(wins, closed.length) : null,
    };
  }).sort((a, b) => b.banked - a.banked || b.inPlay - a.inPlay || b.calls - a.calls);
}

export const BUCKETS = [
  { label: "under 50", lo: 0, hi: 50 },
  { label: "50–59", lo: 50, hi: 60 },
  { label: "60–69", lo: 60, hi: 70 },
  { label: "70–79", lo: 70, hi: 80 },
  { label: "80 and up", lo: 80, hi: 101 },
] as const;

export interface Bucket { label: string; n: number; said: number | null; hit: number | null }

/** Calibration: for calls rated in each band, the average stated chance vs how often they actually beat SPY. */
export function calibration(rounds: Round[]): Bucket[] {
  const r = rounds.filter((x) => x.closed && x.win !== null && x.calibrated && x.confidence !== null);
  return BUCKETS.map((b) => {
    const inB = r.filter((x) => x.confidence! >= b.lo && x.confidence! < b.hi);
    return { label: b.label, n: inB.length, said: inB.length ? inB.reduce((a, x) => a + x.confidence!, 0) / inB.length / 100 : null, hit: inB.length ? inB.filter((x) => x.win).length / inB.length : null };
  });
}

export interface SplitRow { key: string; calls: number; closed: number; wins: number; hitRate: number | null; banked: number; avg: number | null }

/** Closed and open calls grouped by a label (crowding stage at entry, analyst coverage): does it change the results? */
export function splitBy(rounds: Round[], keyOf: (r: Round) => string | null, order: string[]): SplitRow[] {
  const rows = new Map<string, Round[]>();
  for (const r of rounds) { const k = keyOf(r); if (k) rows.set(k, [...(rows.get(k) ?? []), r]); }
  return order.filter((k) => rows.has(k)).map((key) => {
    const rs = rows.get(key)!;
    const closed = rs.filter((r) => r.closed && r.points !== null);
    const wins = closed.filter((r) => r.win).length;
    const banked = closed.reduce((a, r) => a + r.points!, 0);
    return { key, calls: rs.length, closed: closed.length, wins, hitRate: closed.length ? wins / closed.length : null, banked, avg: closed.length ? Math.round(banked / closed.length) : null };
  });
}

/** Wins / closed calls for each kind of call and player. */
export function byKind(rounds: Round[]): Record<string, Partial<Record<Player, { wins: number; closed: number; points: number }>>> {
  const out: Record<string, Partial<Record<Player, { wins: number; closed: number; points: number }>>> = {};
  for (const r of rounds) {
    if (!r.closed || r.points === null) continue;
    const cell = ((out[r.kind] ??= {})[r.player] ??= { wins: 0, closed: 0, points: 0 });
    cell.closed++;
    if (r.win) cell.wins++;
    cell.points += r.points;
  }
  return out;
}
