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
export const PLAYERS = ["scout_trend", "scout_story", "you", "stream_host", "stream_agent"] as const;
export type Player = (typeof PLAYERS)[number];
export const PLAYER_LABEL: Record<Player, string> = {
  scout_trend: "Scout · trend desk",
  scout_story: "Scout · story desk",
  you: "You",
  stream_host: "Stream file · host",
  stream_agent: "Stream file · agent",
};

/** Who made the call: by origin, and by the candidate term the card came from. */
export function playerOf(origin: "scout" | "human", term: string | undefined): Player {
  const t = (term ?? "").toLowerCase();
  if (origin === "scout") return t.startsWith("story:") ? "scout_story" : "scout_trend";
  if (t.startsWith("stream host:")) return "stream_host";
  if (t.startsWith("stream agent:")) return "stream_agent";
  return "you";
}

export interface Round extends IdeaResult { player: Player; points: number | null; win: boolean | null; confidence: number | null; calibrated: boolean }

export function toRound(i: IdeaResult, player: Player, confidence: number | null, calibrated: boolean): Round {
  const points = i.excess === null ? null : Math.round(i.excess * STAKE);
  return { ...i, player, points, win: i.excess === null ? null : i.excess > 0, confidence, calibrated };
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
  banked: number; inPlay: number; best: Round | null; worst: Round | null;
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
