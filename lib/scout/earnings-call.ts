/**
 * The latest earnings call, for research: when a stock reported in the last few weeks, the card's research is shown
 * what management said about the road ahead and what the analysts pressed on. A press release is the company's
 * edited telling; the questions are where the doubts show (Ambarella's Nov 24, 2026 call is where "memory supply
 * challenges" and the state of its sale talks would have surfaced).
 *
 * Not used by the earnings-drift desk: its cards may only use what was public before the paper entry, and a
 * transcript arrives days later. Changing what this tells the model changes research input: bump CALL_REVISION.
 */
import { getJson } from "../http";
import { secTickerList } from "../sources/edgar";
import { callDigest, fetchCall, fiscalLabel } from "../sources/transcripts";
import { addDays, toEt } from "../time";
import * as store from "./store";

export const CALL_REVISION = 1;
export const EARNINGS_CALL = { recentDays: 25, perDay: 20, retryHours: 20 };

interface Cached { at: string; label: string; digest: string | null }

/** The call digest for the quarter a stock reported on `reportDate`, cached; null when there is none (yet) or today's quota is used. */
export async function callFor(symbol: string, reportDate: string, env: NodeJS.ProcessEnv, now: Date, fetchImpl?: typeof fetch): Promise<{ label: string; digest: string } | null> {
  const key = env.ALPHAVANTAGE_API_KEY?.trim(), ua = env.SEC_USER_AGENT?.trim();
  if (!key || !ua) return null;
  const cik = (await secTickerList(ua, fetchImpl)).find((t) => t.ticker === symbol)?.cik;
  if (!cik) return null;
  const sub = await getJson<{ fiscalYearEnd?: string }>(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, { headers: { "user-agent": ua }, minIntervalMs: 150, cacheMs: 3 * 3600_000, fetchImpl, retries: 1 });
  const label = sub.fiscalYearEnd ? fiscalLabel(sub.fiscalYearEnd, reportDate) : null;
  if (!label) return null;
  const cacheKey = `call:${symbol}:${label}`;
  const hit = (await store.cacheGet<Cached>(cacheKey).catch(() => null))?.data ?? null;
  if (hit?.digest) return { label, digest: hit.digest };
  // No transcript last time: small companies' calls arrive late or never, so it is asked again about once a day.
  if (hit && now.getTime() - Date.parse(hit.at) < EARNINGS_CALL.retryHours * 3600_000) return null;
  const day = toEt(now).date, countKey = `call:asked:${day}`;
  const asked = (await store.cacheGet<{ n: number }>(countKey).catch(() => null))?.data?.n ?? 0;
  if (asked >= EARNINGS_CALL.perDay) return null;
  await store.cachePut(countKey, { n: asked + 1 });
  const got = await fetchCall(symbol, label, key, fetchImpl);
  if ("limited" in got) { console.warn(`earnings call ${symbol} ${label}: ${got.limited}`); return null; }
  const digest = callDigest(got.turns);
  await store.cachePut(cacheKey, { at: now.toISOString(), label, digest } satisfies Cached);
  console.log(`earnings call ${symbol} ${label}: ${got.turns.length ? `${got.turns.length} turns${digest ? "" : ", nothing usable"}` : "no transcript yet"}`);
  return digest ? { label, digest } : null;
}

/** For research: the stock's latest call when it reported in the last few weeks, as a block for the prompt; else null. */
export async function earningsCallText(symbol: string | undefined, now: Date, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<string | null> {
  if (!symbol || !env.ALPHAVANTAGE_API_KEY?.trim()) return null;
  const last = (await store.symbolInfo([symbol]).catch(() => new Map<string, store.SymbolInfo>())).get(symbol)?.lastEarnings ?? null;
  const today = toEt(now).date;
  if (!last || last > today || last < addDays(today, -EARNINGS_CALL.recentDays)) return null;
  const call = await callFor(symbol, last, env, now, fetchImpl);
  if (!call) return null;
  return `Earnings call (${symbol} reported ${last}; from the call's transcript, fiscal ${call.label}, picked out by code: management's forward-looking remarks and the analysts' questions). Management's words are its own telling, not proof; the questions show where the doubts are. Use it for guidance, tone and what was pressed on, and say when it changes the call:\n${call.digest}`;
}
