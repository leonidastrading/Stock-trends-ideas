/**
 * What a card's symbol is, in plain sight: the name it trades as today (from
 * the live listing, so a reused ticker such as SATS shows up as the Strive
 * preferred it now is) and the next earnings release.
 *
 * The next earnings date is an estimate: the company's past earnings releases
 * (8-K item 2.02 filings at the SEC) give its usual spacing, and the next one
 * is the last plus that spacing. Companies announce the exact date a few weeks
 * ahead; this is labelled "est." until a dated calendar source is added.
 */
import type { MarketData } from "../alpaca";
import { fetchEarningsDates } from "../sources/edgar";
import { addDays, daysBetween, toEt } from "../time";
import * as store from "./store";

/** Pure: next release from past ones (oldest first). Typical gap = median of the last gaps between 60 and 120 days. */
export function estimateNextEarnings(dates: string[], today: string): { last: string | null; next: string | null; basis: string | null } {
  const d = [...new Set(dates)].sort();
  const last = d.at(-1) ?? null;
  if (!last) return { last: null, next: null, basis: null };
  const gaps = d.slice(1).map((x, i) => daysBetween(d[i], x)).filter((g) => g >= 60 && g <= 120).slice(-4);
  if (!gaps.length) return { last, next: null, basis: null };
  const g = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  let next = addDays(last, g);
  while (daysBetween(today, next) < -7) next = addDays(next, g); // a missed filing: roll forward
  return { last, next, basis: `est. from ${gaps.length + 1} past releases, usual gap ${g} days` };
}

/** Look up and store name and earnings for symbols not checked in the last `maxAgeHours`. Never throws. */
export async function refreshSymbolInfo(data: MarketData | null, env: NodeJS.ProcessEnv, symbols: string[], now: Date, maxAgeHours = 20, fetchImpl?: typeof fetch): Promise<{ checked: number; errors: string[] }> {
  const out = { checked: 0, errors: [] as string[] };
  const today = toEt(now).date;
  const fresh = await store.freshSymbols(maxAgeHours);
  const ua = env.SEC_USER_AGENT?.trim();
  for (const symbol of [...new Set(symbols)].filter((s) => !fresh.has(s))) {
    try {
      const asset = data?.getAsset ? await data.getAsset(symbol) : undefined;
      const dates = ua ? await fetchEarningsDates(symbol, addDays(today, -460), ua, fetchImpl).catch(() => null) : null;
      const e = dates ? estimateNextEarnings(dates, today) : { last: null, next: null, basis: null };
      await store.upsertSymbolInfo({ symbol, name: asset === undefined ? null : asset?.name || "(not a listed symbol now)", exchange: asset?.exchange ?? null, tradable: asset === undefined ? null : !!asset?.tradable, lastEarnings: e.last, nextEarnings: e.next, nextBasis: e.basis });
      out.checked++;
    } catch (err) {
      out.errors.push(`${symbol}: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
    }
  }
  return out;
}
