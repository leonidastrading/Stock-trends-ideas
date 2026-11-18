/**
 * The "crash and bounce" short setup, on daily bars (pure; runs in the browser on the chart's bars too).
 *
 * Setup
 * 1. Run-up: a new 1-year high at least 5x the 1-year low. That high is the peak; it moves up with any higher high.
 * 2. Crash: within 18 trading days of the peak, a low at least 44% below it. The lowest low of the drop is the first
 *    low; it moves down with any lower low.
 * Filters: actual (unadjusted) price at least $10 and average daily dollar volume at least $5M on the trigger day; the
 * peak day closed within 20% of its high. (Real stocks or ADRs only, no leveraged ETFs or SPACs: checked by the caller.)
 * Trigger: the first day the high reaches first low + 1/2 x (peak - first low). Cancelled by a trade above the peak.
 * Entry: short when a day's low breaks the prior level, starting from the trigger day's low; a day that doesn't break
 * moves the level up to its own low. Cancelled after 20 days with no break, or by a trade above the peak.
 * Exits, first hit: stop just above the highest high from the trigger day to entry; target 10% below the first low;
 * otherwise cover at the close 60 trading days after entry. A day that touches both stop and target counts as the stop.
 */

export const CRASH_BOUNCE = { lookback: 252, minHistory: 200, runUp: 5, crashDays: 18, crashPct: 44, peakCloseWithin: 0.2, retrace: 0.5, entryDays: 20, targetBelowLow: 0.1, holdDays: 60, minPrice: 10, minDollarVolume: 5e6, advDays: 20, tick: 0.01 };

/** [date, open, high, low, close, volume], oldest first. */
export type Bar = [string, number, number, number, number, number];
export interface Point { date: string; price: number }

export interface CrashBounce {
  peak: Point & { runUp: number; closeOk: boolean };
  firstLow: Point & { dropPct: number };
  level: number;
  trigger: Point | null;
  /** The level a break must go below (the latest one while waiting for the entry). */
  entryLevel: number | null;
  entry: Point | null;
  stop: number | null;
  target: number;
  exit: (Point & { reason: "stop" | "target" | "time" }) | null;
  returnPct: number | null;
  status: "waiting for trigger" | "waiting for entry" | "short open" | "closed" | "cancelled";
  note: string;
  filters: { price: number | null; dollarVolume: number | null; ok: boolean; why: string[] };
  /** The last bar date the setup was followed to (where its lines end). */
  until: string;
}

const round = (x: number) => Math.round(x * 100) / 100;

/**
 * Pure: every setup in the bars, oldest first. `raw` gives the actual (unadjusted) close and volume per date, for the
 * price and dollar-volume filters; without it the bars' own prices are used.
 */
export function findCrashBounce(bars: Bar[], raw?: Map<string, { c: number; v: number }>, cfg = CRASH_BOUNCE): CrashBounce[] {
  const out: CrashBounce[] = [];
  const n = bars.length;
  const H = (i: number) => bars[i][2], L = (i: number) => bars[i][3], C = (i: number) => bars[i][4], O = (i: number) => bars[i][1];
  const lowest = (a: number, b: number) => { let m = Infinity; for (let k = Math.max(0, a); k <= b; k++) m = Math.min(m, L(k)); return m; };
  const highest = (a: number, b: number) => { let m = -Infinity; for (let k = Math.max(0, a); k <= b; k++) m = Math.max(m, H(k)); return m; };
  const isRunUpHigh = (i: number) => i >= cfg.minHistory && H(i) >= highest(i - cfg.lookback + 1, i) && H(i) >= cfg.runUp * lowest(i - cfg.lookback + 1, i);

  let i = 0;
  while (i < n) {
    if (!isRunUpHigh(i)) { i++; continue; }
    // Peak, moving up with higher highs, until a crash within 18 trading days of it (or none).
    let p = i, crash = -1;
    for (let j = i + 1; j < n && j - p <= cfg.crashDays; j++) {
      if (H(j) > H(p)) { p = j; continue; }
      if (L(j) <= H(p) * (1 - cfg.crashPct / 100)) { crash = j; break; }
    }
    if (crash < 0) { i = p + 1; continue; }
    const peakHigh = H(p);
    const runUp = peakHigh / lowest(p - cfg.lookback + 1, p);
    const closeOk = C(p) >= peakHigh * (1 - cfg.peakCloseWithin);
    // First low, moving down with lower lows, until the bounce reaches the level (or a trade above the peak).
    let lo = crash, trig = -1, cancel = "", k = crash + 1;
    for (; k < n; k++) {
      if (H(k) > peakHigh) { cancel = `traded above the peak on ${bars[k][0]}`; break; }
      const level = L(lo) + cfg.retrace * (peakHigh - L(lo));
      if (H(k) >= level) { trig = k; break; }
      if (L(k) < L(lo)) lo = k;
    }
    const level = L(lo) + cfg.retrace * (peakHigh - L(lo));
    const base = {
      peak: { date: bars[p][0], price: round(peakHigh), runUp: Math.round(runUp * 10) / 10, closeOk },
      firstLow: { date: bars[lo][0], price: round(L(lo)), dropPct: Math.round((1 - L(lo) / peakHigh) * 1000) / 10 },
      level: round(level), target: round(L(lo) * (1 - cfg.targetBelowLow)),
    };
    const filters = (at: number) => {
      const rc = raw?.get(bars[at][0])?.c ?? C(at);
      let dv = 0, days = 0;
      for (let q = Math.max(0, at - cfg.advDays + 1); q <= at; q++) { const r = raw?.get(bars[q][0]); dv += (r?.c ?? C(q)) * (r?.v ?? bars[q][5]); days++; }
      const adv = days ? dv / days : null;
      const why = [
        rc < cfg.minPrice ? `actual price $${rc.toFixed(2)} is under $${cfg.minPrice}` : "",
        adv !== null && adv < cfg.minDollarVolume ? `average daily volume $${(adv / 1e6).toFixed(1)}M is under $${cfg.minDollarVolume / 1e6}M` : "",
        !closeOk ? `the peak day closed more than ${cfg.peakCloseWithin * 100}% below its high (a wick peak)` : "",
      ].filter(Boolean);
      return { price: round(rc), dollarVolume: adv !== null ? Math.round(adv) : null, ok: why.length === 0, why };
    };

    if (trig < 0) {
      const at = Math.min(k, n - 1);
      out.push({ ...base, trigger: null, entryLevel: null, entry: null, stop: null, exit: null, returnPct: null, status: cancel ? "cancelled" : "waiting for trigger", note: cancel ? `Cancelled before the trigger: ${cancel}.` : `Waiting for the bounce to reach $${base.level.toFixed(2)}.`, filters: filters(lo), until: bars[at][0] });
      i = cancel ? k : n;
      continue;
    }

    // Entry: a break of the prior level, starting from the trigger day's low; days that don't break move it up.
    let lvl = L(trig), ent = -1, entPrice = 0, m = trig + 1;
    cancel = "";
    for (; m < n && m - trig <= cfg.entryDays; m++) {
      if (H(m) > peakHigh) { cancel = `traded above the peak on ${bars[m][0]}`; break; }
      if (L(m) < lvl) { ent = m; entPrice = Math.min(O(m), lvl); break; }
      lvl = L(m);
    }
    const f = filters(trig);
    const trigger = { date: bars[trig][0], price: round(H(trig)) };
    if (ent < 0) {
      const expired = !cancel && m - trig > cfg.entryDays;
      const at = Math.min(m, n - 1);
      out.push({ ...base, trigger, entryLevel: round(lvl), entry: null, stop: null, exit: null, returnPct: null,
        status: cancel || expired ? "cancelled" : "waiting for entry",
        note: cancel ? `Cancelled before the entry: ${cancel}.` : expired ? `Cancelled: no break in ${cfg.entryDays} days after the trigger.` : `Short on a break below $${round(lvl).toFixed(2)} (the latest day's low).`,
        filters: f, until: bars[at][0] });
      i = cancel || expired ? m : n;
      continue;
    }

    // Exits from the entry: stop, target, or the close 60 trading days later.
    const stop = round(highest(trig, ent) + cfg.tick);
    const target = base.target;
    let exit: CrashBounce["exit"] = null, e = ent;
    if (L(ent) <= target) exit = { date: bars[ent][0], price: target, reason: "target" };
    for (e = ent + 1; !exit && e < n; e++) {
      const hitStop = H(e) >= stop, hitTarget = L(e) <= target;
      if (hitStop) exit = { date: bars[e][0], price: round(Math.max(O(e), stop)), reason: "stop" };
      else if (hitTarget) exit = { date: bars[e][0], price: round(Math.min(O(e), target)), reason: "target" };
      else if (e - ent >= cfg.holdDays) exit = { date: bars[e][0], price: round(C(e)), reason: "time" };
      if (exit) break;
    }
    const entry = { date: bars[ent][0], price: round(entPrice) };
    const last = exit ? bars.findIndex((b) => b[0] === exit!.date) : n - 1;
    out.push({ ...base, trigger, entryLevel: round(lvl), entry, stop, exit,
      returnPct: exit ? Math.round((1 - exit.price / entry.price) * 1000) / 10 : Math.round((1 - C(n - 1) / entry.price) * 1000) / 10,
      status: exit ? "closed" : "short open",
      note: exit ? `Covered on ${exit.date} at $${exit.price.toFixed(2)} (${exit.reason}).` : `Short open since ${entry.date}; ${n - 1 - ent} of ${cfg.holdDays} trading days used.`,
      filters: f, until: bars[last][0] });
    i = exit ? last + 1 : n;
  }
  return out;
}
