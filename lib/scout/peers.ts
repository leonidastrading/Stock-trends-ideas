/**
 * Opposite calls on companies in the same industry.
 *
 * The duplicate and conflict checks worked per stock: nothing noticed that one desk was long Lennar while another
 * card was short Toll Brothers (November 2026), two homebuilders that mostly rise and fall together. Held at once,
 * two such calls largely cancel into "this builder beats that one", which neither card said.
 *
 * Now: every stock with an open call has its industry on file (the SEC's four-digit industry code for the company).
 * When a card is researched, the open calls on other companies in the same industry are put in front of the
 * researcher, which has to say, if its call points the other way from one of them, why both can hold or that the
 * new one replaces the old. A card that still ends up opposite a peer carries a note saying so, and so does the
 * older card. Nothing is blocked: an opposite call on a peer can be right (one company gains at the other's cost).
 *
 * A few industry codes are too wide to mean "these move together" (all software, all drug makers, all property
 * trusts, blank-check companies): those are left out.
 *
 * Changing what research is told here changes research input: bump PEERS_REVISION (part of the scout's version).
 */
import { getJson } from "../http";
import type { OpenCall } from "./conflicts";
import * as store from "./store";

export const PEERS_REVISION = 1;
export const PEERS = { keepDays: 180, perFill: 150, show: 6 };

/** Industry codes too wide to say two companies move together. */
export const TOO_WIDE = new Set(["7372", "7370", "7371", "7373", "7374", "7389", "2834", "2836", "6798", "6770", "6199", "6211", "6221", "8742", "9995"]);

export interface Industry { sic: string; label: string; at: string }
export type IndustryMap = Record<string, Industry>;
const KEY = "industries:v1";

/** The industries on file, by symbol. */
export async function industries(): Promise<IndustryMap> {
  return (await store.cacheGet<IndustryMap>(KEY).catch(() => null))?.data ?? {};
}

/** Look up and keep the industry of each symbol that has none on file (or an old one). Returns how many were added. */
export async function fillIndustries(symbols: string[], env: NodeJS.ProcessEnv = process.env, max = PEERS.perFill, fetchImpl?: typeof fetch): Promise<number> {
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua || !symbols.length) return 0;
  const map = await industries();
  const stale = Date.now() - PEERS.keepDays * 86400_000;
  const todo = [...new Set(symbols.map((s) => s.toUpperCase()))].filter((s) => !map[s] || Date.parse(map[s].at) < stale).slice(0, max);
  if (!todo.length) return 0;
  const { secTickerList } = await import("../sources/edgar");
  const list = await secTickerList(ua, fetchImpl).catch(() => []);
  const cikOf = new Map(list.map((x) => [x.ticker, x.cik]));
  let added = 0;
  for (const s of todo) {
    const cik = cikOf.get(s);
    // No SEC company under the symbol (a fund, a foreign listing): kept as "none" so it is not asked again every pass.
    if (!cik) { map[s] = { sic: "", label: "", at: new Date().toISOString() }; continue; }
    try {
      const sub = await getJson<{ sic?: string; sicDescription?: string }>(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 150, cacheMs: 24 * 3600_000, fetchImpl, retries: 1, timeoutMs: 12_000 });
      map[s] = { sic: String(sub.sic ?? "").trim(), label: String(sub.sicDescription ?? "").trim().toLowerCase(), at: new Date().toISOString() };
      added++;
    } catch { /* tried again on a later pass */ }
  }
  await store.cachePut(KEY, map).catch(() => undefined);
  return added;
}

export interface PeerCall extends OpenCall { label: string }

/** Pure: the open calls on other companies in the same (narrow enough) industry as this stock. */
export function peerCalls(symbol: string, calls: OpenCall[], map: IndustryMap): PeerCall[] {
  const me = map[symbol.toUpperCase()];
  if (!me?.sic || TOO_WIDE.has(me.sic)) return [];
  return calls.filter((c) => c.symbol !== symbol.toUpperCase() && map[c.symbol]?.sic === me.sic).map((c) => ({ ...c, label: me.label }));
}

/** Pure: of those, the ones that point the other way from a call in this direction. */
export const peerConflicts = (symbol: string, direction: "long" | "short", calls: OpenCall[], map: IndustryMap): PeerCall[] => peerCalls(symbol, calls, map).filter((c) => c.direction !== direction);

const listed = (xs: PeerCall[]) => xs.slice(0, PEERS.show).map((c) => `#${c.cardId} ${c.direction} ${c.symbol}`).join(", ");

/** Pure: what research is told about open calls on the stock's industry peers (null when there are none). */
export function peersText(symbol: string, peers: PeerCall[], thesisOf: (cardId: number) => string | undefined = () => undefined): string | null {
  if (!peers.length) return null;
  const lines = peers.slice(0, PEERS.show).map((c) => `- card #${c.cardId}: ${c.direction} ${c.symbol}${thesisOf(c.cardId) ? `: ${thesisOf(c.cardId)!.slice(0, 220)}` : ""}`);
  return `THE SCOUT'S OPEN CALLS ON OTHER COMPANIES IN ${symbol}'S INDUSTRY (${peers[0].label || "same industry code"}); these stocks mostly rise and fall together:\n${lines.join("\n")}\nIf your call on ${symbol} points the other way from any of these (long here while one is short, or short here while one is long), the two largely cancel into "this company beats that one". Then you must say so: add an entry to "unknowns" that begins "Against open call #N:" and states either why both can hold at once (what makes ${symbol} different from that company over this card's time limit) or that this call should replace the older one. If you cannot say why ${symbol} differs, lower the confidence. A call in the same direction as these needs no such entry.`;
}

/** Pure: the note a card carries when it is opposite an open call on a peer. */
export function peerNote(conflicts: PeerCall[]): string | null {
  return conflicts.length ? `opposite call on a peer in the same industry (${conflicts[0].label || "same industry code"}): ${listed(conflicts)}${conflicts.length > PEERS.show ? ` and ${conflicts.length - PEERS.show} more` : ""}` : null;
}
