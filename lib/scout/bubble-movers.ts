/**
 * Bubbles, part two: anything going parabolic on hype, with or without a dated event. A single stock on a story
 * (a quantum-computing pop, a meme squeeze), a whole theme (quantum, AI, nuclear, drones, space) or a commodity
 * (oil, gold, silver, bitcoin through its ETFs).
 *
 * "Parabolic" is measured on each asset's own scale, so a 20% month in oil counts like an 80% month in a quantum
 * small cap: the 30-day move in standard deviations of its own daily moves (from the 4 months before), how far it sits
 * above its 50-day average, and whether the rise is speeding up (most of the month's gain in the last two weeks).
 * Hype is the attention on top: Stocktwits messages far above the stock's normal, crowding stage 3+, or volume
 * several times normal.
 */
import type { DailyBar } from "../alpaca";

/** Theme baskets checked every pass (US-listed; ETFs stand in for commodities and crypto). */
export const THEME_BASKETS: Record<string, string[]> = {
  "Quantum computing": ["IONQ", "RGTI", "QBTS", "QUBT", "ARQQ"],
  "AI chips and servers": ["NVDA", "AMD", "AVGO", "SMCI", "ARM", "MU"],
  "AI software": ["PLTR", "AI", "SOUN", "BBAI", "PATH"],
  "Nuclear and uranium": ["OKLO", "SMR", "NNE", "CCJ", "LEU", "URA"],
  "Space": ["RKLB", "ASTS", "LUNR", "RDW", "PL"],
  "Drones and defense tech": ["AVAV", "KTOS", "RCAT", "UMAC", "ONDS"],
  "Crypto": ["IBIT", "COIN", "MSTR", "MARA", "HOOD"],
  "Oil": ["USO", "XLE", "OXY", "XOM", "CVX"],
  "Gold and silver": ["GLD", "SLV", "GDX", "NEM", "PAAS"],
  "eVTOL and flying taxis": ["JOBY", "ACHR", "EH"],
  "Meme stocks": ["GME", "AMC", "KOSS", "BBBY"],
  "Robotics": ["TSLA", "SERV", "SYM", "TER"],
};

export const PARABOLA = { sigmaMania: 3.5, sigmaBuilding: 2.5, ext50Mania: 20, accelShare: 0.5, volLoud: 3, minPrice: 2 };

export interface Parabola {
  price: number; run5: number; run30: number; run90: number | null; ext50: number | null; volRatio: number | null;
  /** The 30-day move in standard deviations of the asset's own daily moves over the four months before it. */
  sigmas30: number | null;
  /** Share of the 30-day gain made in the last 10 sessions (above 0.5 = speeding up). */
  accel: number | null;
}

const ret = (a: number, b: number) => Math.round((b / a - 1) * 1000) / 10;

/** Pure: how parabolic a price path is (bars in any order; needs about 4 months). Null with too little history. */
export function parabola(bars: DailyBar[]): Parabola | null {
  const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (s.length < 60) return null;
  const last = s[s.length - 1];
  const at = (k: number) => s[Math.max(0, s.length - 1 - k)];
  const run30 = ret(at(21).c, last.c), run5 = ret(at(5).c, last.c), run10 = ret(at(10).c, last.c);
  const run90 = s.length > 64 ? ret(at(63).c, last.c) : null;
  const sma50 = s.slice(-50).reduce((x, b) => x + b.c, 0) / 50;
  // Daily log-moves over the ~4 months before the last 30 days.
  const moves: number[] = [];
  for (let i = Math.max(1, s.length - 21 - 84); i < s.length - 21; i++) { const m = Math.log(s[i].c / s[i - 1].c); if (Number.isFinite(m)) moves.push(m); }
  const mean = moves.reduce((x, y) => x + y, 0) / (moves.length || 1);
  const sd = moves.length > 20 ? Math.sqrt(moves.reduce((x, y) => x + (y - mean) ** 2, 0) / (moves.length - 1)) : null;
  const sigmas30 = sd && sd > 0 ? Math.round((Math.log(last.c / at(21).c) / (sd * Math.sqrt(21))) * 10) / 10 : null;
  const vol10 = s.slice(-10).reduce((x, b) => x + (b.v ?? 0), 0) / 10;
  const vol90 = s.slice(-90, -10).reduce((x, b) => x + (b.v ?? 0), 0) / Math.max(1, Math.min(80, s.length - 10));
  return {
    price: last.c, run5, run30, run90, ext50: Math.round((last.c / sma50 - 1) * 1000) / 10,
    volRatio: vol90 > 0 ? Math.round((vol10 / vol90) * 10) / 10 : null, sigmas30,
    accel: run30 > 0 ? Math.round((run10 / run30) * 100) / 100 : null,
  };
}

export type HypeLevel = "mania" | "building" | "quiet";

/**
 * Pure: mania = a 3.5-sigma month that is still speeding up, 20%+ above its 50-day average, with loud attention
 * (Stocktwits far above normal, crowding stage 3+, or volume 3x normal). Building = a 2.5-sigma month up.
 */
export function hypeLevel(p: Parabola, hype: { z: number | null; stage: number | null }): HypeLevel {
  if (p.sigmas30 === null || p.run30 <= 0) return "quiet";
  const loud = (hype.z !== null && hype.z >= 2) || (hype.stage !== null && hype.stage >= 3) || (p.volRatio !== null && p.volRatio >= PARABOLA.volLoud);
  const speeding = p.accel !== null && p.accel >= PARABOLA.accelShare;
  if (p.sigmas30 >= PARABOLA.sigmaMania && speeding && (p.ext50 ?? 0) >= PARABOLA.ext50Mania && loud) return "mania";
  if (p.sigmas30 >= PARABOLA.sigmaBuilding) return "building";
  return "quiet";
}

/** Pure: a theme's state from its members: how many are building or mania, and the median 30-day move. */
export function themeState(members: Array<{ symbol: string; level: HypeLevel; run30: number | null }>): { hot: number; median30: number | null; level: HypeLevel } {
  const runs = members.map((m) => m.run30).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const median30 = runs.length ? runs[Math.floor(runs.length / 2)] : null;
  const mania = members.filter((m) => m.level === "mania").length, hot = members.filter((m) => m.level !== "quiet").length;
  const level: HypeLevel = members.length && (mania >= 2 || hot >= Math.ceil(members.length * 0.6)) ? (mania >= 2 ? "mania" : "building") : hot >= 2 ? "building" : "quiet";
  return { hot, median30, level };
}
