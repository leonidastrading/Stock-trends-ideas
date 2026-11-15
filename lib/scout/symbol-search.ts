/** Ticker search suggestions: every active US stock and ETF (Alpaca's asset list, cached daily), matched on ticker or company name. */
import { marketDataFromEnv } from "../alpaca";

export interface Listing { s: string; n: string; x: string }
export interface Suggestion { symbol: string; name: string; exchange: string }

const NAME_NOISE = /\b(common stock|ordinary shares?|class [a-c]( common stock| ordinary shares?)?|american depositary shares?( each representing [^,;]*)?|depositary shares?|units?|warrants?|rights?|shares of beneficial interest|beneficial interest|new|\(the\))\b/gi;

/** Pure: a company name as people say it ("NVIDIA Corporation Common Stock" → "NVIDIA Corporation"). */
export const cleanName = (n: string) => n.replace(NAME_NOISE, "").replace(/\s*[,;]\s*$/, "").replace(/\s{2,}/g, " ").replace(/[\s,;-]+$/, "").trim();

/** What people call a company when it is not in its listed name (checked against the live list: only listed symbols are offered). */
const NICKNAMES: Record<string, string[]> = {
  spacex: ["SPCX"], "space x": ["SPCX"], starlink: ["SPCX"], google: ["GOOGL", "GOOG"], alphabet: ["GOOGL", "GOOG"], facebook: ["META"], instagram: ["META"],
  berkshire: ["BRK.B", "BRK.A"], "jp morgan": ["JPM"], jpmorgan: ["JPM"], chase: ["JPM"], "goldman": ["GS"], "coke": ["KO"], "coca cola": ["KO"], pepsi: ["PEP"],
  walmart: ["WMT"], disney: ["DIS"], tsmc: ["TSM"], "taiwan semi": ["TSM"], asml: ["ASML"], tesla: ["TSLA"], amazon: ["AMZN"], microsoft: ["MSFT"], apple: ["AAPL"],
  nvidia: ["NVDA"], netflix: ["NFLX"], "s&p": ["SPY"], "s and p": ["SPY"], "nasdaq 100": ["QQQ"], "russell": ["IWM"], gold: ["GLD"], bitcoin: ["IBIT"],
  palantir: ["PLTR"], "super micro": ["SMCI"], supermicro: ["SMCI"], "home depot": ["HD"], "united health": ["UNH"], unitedhealth: ["UNH"],
};

const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const MAJOR = new Set(["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS"]);

/** Pure: the best matches for what was typed, best first. Ticker matches beat name matches; big exchanges beat OTC. */
export function suggest(list: readonly Listing[], typed: string, limit = 8): Suggestion[] {
  const raw = typed.trim().replace(/^\$/, "");
  if (!raw) return [];
  const sym = raw.toUpperCase().replace(/-/g, ".");
  const q = norm(raw);
  const scored: Array<[number, Listing]> = [];
  // Nicknames first: "spacex" → SPCX (when typed far enough to be unambiguous).
  const nick = new Set(q.length >= 3 ? Object.entries(NICKNAMES).filter(([k]) => k.startsWith(q) || q.startsWith(k)).flatMap(([, v]) => v) : []);
  for (const l of list) {
    if (nick.has(l.s) && l.s !== sym) { scored.push([1 + [...nick].indexOf(l.s) / 10, l]); continue; }
    let score = -1;
    if (l.s === sym) score = 0;
    else if (l.s.startsWith(sym) && /^[A-Z.]+$/.test(sym)) score = 10 + l.s.length - sym.length;
    else if (q.length >= 2) {
      const name = norm(cleanName(l.n));
      if (name.startsWith(q)) score = 20 + Math.min(name.length, 60) / 100;
      else if (name.includes(` ${q}`)) score = 30 + Math.min(name.length, 60) / 100;
      else if (q.length >= 4 && (name.includes(q) || name.replace(/ /g, "").includes(q.replace(/ /g, "")))) score = 40;
    }
    if (score < 0) continue;
    if (!MAJOR.has(l.x)) score += 5;
    if (/\b(warrant|right|unit)s?\b/i.test(l.n) || /\.(W|WS|U|R)$|W$/.test(l.s) && l.s !== sym && l.s.length > 4) score += 3;
    scored.push([score, l]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].s.localeCompare(b[1].s)).slice(0, limit).map(([, l]) => ({ symbol: l.s, name: cleanName(l.n), exchange: l.x }));
}

/** Pure: what a search means. An exact ticker wins; otherwise the best match; with no stock list loaded, the text as a ticker; else null (not listed). */
export function resolveTyped(list: readonly Listing[], typed: string): string | null {
  const sym = typed.trim().replace(/^\$/, "").toUpperCase().replace(/-/g, ".");
  if (list.some((l) => l.s === sym)) return sym;
  return suggest(list, typed, 1)[0]?.symbol ?? (!list.length && /^[A-Z]{1,5}(\.[A-Z])?$/.test(sym) ? sym : null);
}

let memo: { at: number; list: Listing[] } | null = null;

/** The listing, from memory, else the daily cache, else Alpaca. Empty when Alpaca is not set up. */
export async function listings(): Promise<Listing[]> {
  if (memo && Date.now() - memo.at < 6 * 3600_000) return memo.list;
  const data = marketDataFromEnv();
  if (!data?.listAssets) return [];
  const { panel } = await import("../market/panels");
  const p = await panel<Listing[]>("assets", 24 * 60, async () => (await data.listAssets!()).map((a) => ({ s: a.symbol, n: a.name, x: a.exchange })), 30_000);
  if (p.data?.length) memo = { at: Date.now(), list: p.data };
  return p.data ?? [];
}
