/**
 * Options positioning log. Once each trading day (10:00-16:00 ET, when the chains carry the previous
 * close's open interest) the scout reads the option chains of OPTIONS_UNIVERSE from Cboe, compares each
 * contract's open interest with the last capture, and flags unusual new out-of-the-money positions:
 * large against that stock's own normal day, large in dollars, and not about to expire.
 *
 * What it cannot see: who opened the position or which side they took. Open interest rises by the same
 * amount whether a contract was bought or sold to open, and most big put positions are hedges. A flag
 * says "look at this", not "follow it"; the scoreboard decides whether flags are worth anything.
 */
import { OPTIONS_UNIVERSE } from "@/config/options";
import { optionChain, type Chain, type OptionContract } from "../sources/cboe-options";
import { daysBetween, toEt } from "../time";
import * as store from "./store";
import type { OptionsFlag } from "./store";

export const OPTIONS_RULES = {
  /** Out of the money by at least this much (puts below, calls above the stock). */
  otm: 0.05,
  minDte: 5,
  maxDte: 450,
  minContracts: 2000,
  minPremiumUsd: 2_000_000,
  minNotionalUsd: 200_000_000,
  /** Times the stock's normal large daily increase (median of its daily 95th percentile). */
  minMultiple: 5,
  /** Days of history before the stock's normal is used; until then only very large positions are flagged. */
  baselineDays: 5,
  noBaselineContracts: 20_000,
  noBaselinePremiumUsd: 5_000_000,
  /** Contracts kept in the stored snapshot: open interest at least this. */
  keepOi: 10,
} as const;

export interface OiChange { c: OptionContract; prevOi: number; up: number }

/** Pure: per contract, the increase in open interest since the previous snapshot (new listings start from zero). */
export function diffChain(prev: Record<string, number>, chain: Chain): OiChange[] {
  return chain.contracts.map((c) => ({ c, prevOi: prev[c.contract] ?? 0, up: c.oi - (prev[c.contract] ?? 0) }));
}

/** Pure: the day's summary; p95Up is the 95th percentile of increases among contracts that grew. */
export function daySummary(symbol: string, date: string, prevDate: string | null, chain: Chain, changes: OiChange[]): store.OptionsDay {
  const ups = changes.map((x) => x.up).filter((u) => u > 0).sort((a, b) => a - b);
  return {
    symbol, date, prevDate, contracts: chain.contracts.length,
    callOi: chain.contracts.filter((c) => c.type === "call").reduce((a, c) => a + c.oi, 0), putOi: chain.contracts.filter((c) => c.type === "put").reduce((a, c) => a + c.oi, 0),
    p95Up: ups.length ? ups[Math.min(ups.length - 1, Math.floor(ups.length * 0.95))] : 0, maxUp: ups.at(-1) ?? 0,
  };
}

/** Pure: unusual new out-of-the-money positions, with spread structures named where two strikes moved together. */
export function flagChanges(changes: OiChange[], chain: Chain, date: string, baseline: { median: number | null; n: number }): OptionsFlag[] {
  const R = OPTIONS_RULES;
  const useBase = baseline.n >= R.baselineDays && baseline.median !== null;
  const base = useBase ? Math.max(baseline.median!, 500) : null;
  const sized = (x: OiChange) => {
    const premium = x.c.mid ? x.up * 100 * x.c.mid : null;
    const notional = x.up * 100 * chain.spot;
    return { premium, notional, multiple: base ? x.up / base : null };
  };
  const otm = (c: OptionContract) => (c.type === "put" ? c.strike <= chain.spot * (1 - R.otm) : c.strike >= chain.spot * (1 + R.otm));
  const dte = (c: OptionContract) => daysBetween(date, c.expiry);
  const flags: OptionsFlag[] = [];
  for (const x of changes) {
    if (x.up < R.minContracts || !otm(x.c) || dte(x.c) < R.minDte || dte(x.c) > R.maxDte) continue;
    const s = sized(x);
    const big = (s.premium ?? 0) >= R.minPremiumUsd || s.notional >= R.minNotionalUsd;
    const unusual = s.multiple !== null ? s.multiple >= R.minMultiple : x.up >= R.noBaselineContracts && (s.premium ?? 0) >= R.noBaselinePremiumUsd;
    if (!big || !unusual) continue;
    flags.push({ date, contract: x.c.contract, symbol: chain.symbol, type: x.c.type, strike: x.c.strike, expiry: x.c.expiry, prevOi: x.prevOi, oi: x.c.oi, spot: chain.spot, mid: x.c.mid, volume: x.c.volume, premiumUsd: s.premium === null ? null : Math.round(s.premium), notionalUsd: Math.round(s.notional), baseline: base, multiple: s.multiple === null ? null : Math.round(s.multiple * 10) / 10, structure: null });
  }
  // Structures: on the same expiry and side, a flagged strike paired with the largest other increase further out.
  for (const f of flags) {
    const further = changes.filter((x) => x.c.expiry === f.expiry && x.c.type === f.type && x.c.contract !== f.contract && x.up >= R.minContracts && (f.type === "put" ? x.c.strike < f.strike : x.c.strike > f.strike));
    const nearer = changes.filter((x) => x.c.expiry === f.expiry && x.c.type === f.type && x.c.contract !== f.contract && x.up >= R.minContracts && (f.type === "put" ? x.c.strike > f.strike : x.c.strike < f.strike));
    const up = f.oi - f.prevOi;
    const describe = (near: { strike: number; up: number }, far: { strike: number; up: number }) => {
      const ratio = far.up / near.up;
      const k = (v: number) => `$${v % 1 ? v.toFixed(1) : v}`;
      return ratio >= 0.8 && ratio <= 1.25
        ? `vertical spread: ${k(near.strike)}/${k(far.strike)} ${f.type}s, about ${Math.round(near.up / 1000)}k each`
        : `ratio spread: ${Math.round(near.up / 1000)}k at ${k(near.strike)} against ${Math.round(far.up / 1000)}k at ${k(far.strike)} (1×${ratio.toFixed(1)})`;
    };
    const far = further.sort((a, b) => b.up - a.up)[0];
    const near = nearer.sort((a, b) => b.up - a.up)[0];
    if (far && far.up >= up * 0.3) f.structure = describe({ strike: f.strike, up }, { strike: far.c.strike, up: far.up });
    else if (near && near.up >= up * 0.3) f.structure = describe({ strike: near.c.strike, up: near.up }, { strike: f.strike, up });
  }
  return flags.sort((a, b) => (b.premiumUsd ?? 0) - (a.premiumUsd ?? 0));
}

/** Snapshot to store: contracts with some open interest. */
export const compact = (chain: Chain) => Object.fromEntries(chain.contracts.filter((c) => c.oi >= OPTIONS_RULES.keepOi).map((c) => [c.contract, c.oi]));

/** Housekeeping slice: capture each stock once per trading day, until the deadline. */
export async function runOptionsLog(deadline: number, now = new Date(), fetchImpl?: typeof fetch) {
  const et = toEt(now);
  if (et.weekday === 0 || et.weekday === 6) return "weekend";
  if (et.minutes < 10 * 60 || et.minutes >= 16 * 60) return "outside 10:00-16:00 ET (the chains carry the previous close's open interest then)";
  const done = await store.optionsCapturedOn(et.date);
  const todo = OPTIONS_UNIVERSE.filter((s) => !done.has(s));
  let captured = 0, flagged = 0, skipped = 0, errors = 0;
  const flagsToday: OptionsFlag[] = [];
  for (const symbol of todo) {
    if (Date.now() > deadline) break;
    try {
      const chain = await optionChain(symbol, fetchImpl);
      if (!chain || chain.asOf !== et.date) { skipped++; continue; } // a holiday, or no trade yet today
      const prev = await store.optionsSnapshot(symbol);
      const usable = prev && prev.date < et.date ? prev : null;
      const changes = usable ? diffChain(usable.oi, chain) : [];
      const flags = usable ? flagChanges(changes, chain, et.date, await store.optionsBaseline(symbol, et.date)) : [];
      await store.saveOptionsDay(daySummary(symbol, et.date, usable?.date ?? null, chain, changes), chain.spot, compact(chain), flags);
      captured++;
      flagged += flags.length;
      flagsToday.push(...flags);
    } catch {
      errors++;
    }
  }
  const pushed = await pushTopFlags(flagsToday, now).catch(() => 0);
  return { captured, flagged, skipped, errors, left: Math.max(0, todo.length - captured - skipped - errors), pushed };
}

const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

/** Pure: a flag in one line. */
export function describeFlag(f: OptionsFlag): string {
  const up = f.oi - f.prevOi;
  return `${f.symbol} ${f.expiry} $${f.strike} ${f.type}s: +${up.toLocaleString("en-US")} contracts open (${f.prevOi.toLocaleString("en-US")} → ${f.oi.toLocaleString("en-US")})${f.premiumUsd ? `, about ${usd(f.premiumUsd)} of premium` : ""}, ${usd(f.notionalUsd)} of stock at $${f.spot.toFixed(2)}${f.multiple !== null ? `, ${f.multiple}× the stock's normal large day` : ", no normal yet"}${f.structure ? `; ${f.structure}` : ""}`;
}

/** The day's largest flags (by premium) to the phone: at most three a day, each position once. */
async function pushTopFlags(flags: OptionsFlag[], now: Date): Promise<number> {
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured() || !flags.length) return 0;
  const today = toEt(now).date;
  let room = 3 - (await store.countNotifications(`options:${today}:`));
  let sent = 0;
  for (const f of flags.sort((a, b) => (b.premiumUsd ?? 0) - (a.premiumUsd ?? 0))) {
    if (room <= 0) break;
    if (!(await store.claimNotification(`options:${f.date}:${f.symbol}:${f.expiry}:${f.type}`, `${f.symbol} ${f.type}s`))) continue;
    room--;
    await sendPush({ title: `Options: new ${f.symbol} ${f.type} position`, message: `${describeFlag(f)}. Open interest does not show who bought or sold.`, tags: [f.type === "put" ? "chart_with_downwards_trend" : "chart_with_upwards_trend"], click: process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL.replace(/\/$/, "")}/filings#options` : undefined });
    sent++;
  }
  return sent;
}
