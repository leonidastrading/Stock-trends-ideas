/**
 * Does a ticker still mean the company the card is about? Symbols change hands:
 * EchoStar moved from SATS to ECHO in June 2026 and SATS was reused for a
 * Strive preferred stock, so a card written from memory tracked the wrong
 * security. Before a card is logged, each ticker is checked against what it
 * currently trades as (Alpaca asset metadata) and the SEC's ticker list:
 *
 * - the SEC lists the company under other symbols and not this one → corrected
 *   to the company's current symbol (gate note);
 * - the symbol is a preferred, warrant, unit, right or note → dropped;
 * - the issuer name simply differs (Google vs Alphabet) → kept, with a note.
 */
import type { Asset } from "../alpaca";

const STOP = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "holdings", "holding", "group", "the", "class", "a", "b", "c", "common", "stock", "shares", "share", "ordinary", "sa", "nv", "ag", "se", "ads", "adr", "american", "depositary", "depository", "sponsored", "each", "representing", "one", "new", "llc", "lp", "and", "of", "de", "par", "value", "usd", "com", "cl"]);

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
}

/** Pure: do two issuer names refer to the same company? Same first significant word, or most words shared. */
export function namesMatch(a: string, b: string): boolean {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return false;
  if (x[0] === y[0]) return true;
  const shared = x.filter((t) => t.length >= 4 && y.includes(t)).length;
  return shared >= Math.min(2, Math.min(x.length, y.length));
}

/** Pure: a security that is not the company's common stock (or a fund / ADR), so it cannot stand for the thesis. */
export function notCommon(assetName: string): string | null {
  const m = /\b(preferred|pfd|warrants?|units?|rights|notes? due|debentures|perpetual|subordinated)\b/i.exec(assetName);
  return m ? m[1].toLowerCase() : null;
}

export interface TickerCheck { symbol: string; company: string | null; action: "ok" | "corrected" | "dropped" | "unconfirmed"; to?: string; note: string | null }

/** Pure: decide what to do with one ticker, given what the symbol is now and the SEC's list. */
export function checkTicker(symbol: string, company: string | null, asset: Asset | null, sec: Array<{ cik: string; ticker: string; title: string }> | null, assetFor: (s: string) => Asset | null | undefined = () => undefined): TickerCheck {
  const nowIs = asset?.name ? `${symbol} now trades as "${asset.name}"` : `${symbol} is not a listed symbol now`;
  // The company's own symbols in the SEC list.
  const mine = company && sec ? sec.filter((e) => namesMatch(company, e.title)) : [];
  const ciks = [...new Set(mine.map((e) => e.cik))];
  const own = ciks.length === 1 ? sec!.filter((e) => e.cik === ciks[0]).map((e) => e.ticker) : [];
  if (own.length && !own.includes(symbol)) {
    const to = own.find((t) => {
      const a = assetFor(t);
      return a === undefined || (a !== null && a.tradable && !notCommon(a.name));
    });
    if (to && (!asset || !namesMatch(company!, asset.name))) return { symbol, company, action: "corrected", to, note: `ticker corrected ${symbol} → ${to}: ${nowIs}; the SEC lists ${company} as ${own.join("/")}` };
  }
  if (!asset || !asset.tradable) return { symbol, company, action: "dropped", note: `${nowIs === `${symbol} is not a listed symbol now` ? nowIs : `${symbol} does not trade`}; dropped` };
  const nc = notCommon(asset.name);
  if (nc) return { symbol, company, action: "dropped", note: `${nowIs}, a ${nc} security, not ${company ?? "the company"}'s stock; dropped` };
  if (company && !namesMatch(company, asset.name)) return { symbol, company, action: "unconfirmed", note: `could not confirm ${symbol} is ${company}: ${nowIs}` };
  return { symbol, company, action: "ok", note: null };
}

/**
 * Pure: a card's text with a corrected ticker written the new way ("Short ERJ" → "Short EMBJ"), used before the card
 * is logged, so the thesis does not keep the symbol the card no longer tracks. Whole symbols only; a symbol of one
 * or two letters is replaced only where it is written as a ticker ("$X", "(X)", "long X", "short X", "NYSE: X").
 */
export function renameTickerInText<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value;
  const f = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = new RegExp(`(?<![A-Za-z0-9.$])${f}(?![A-Za-z0-9])`, "g");
  const asTicker = new RegExp(`(\\$|\\(|\\b(?:[Ll]ong|[Ss]hort|LONG|SHORT)\\s+|\\b(?:NYSE|NASDAQ|Nasdaq)\\s*:\\s*)${f}(?![A-Za-z0-9])`, "g");
  const fix = (s: string) => (from.length >= 3 ? s.replace(asTicker, `$1${to}`).replace(whole, to) : s.replace(asTicker, `$1${to}`));
  const walk = (v: unknown): unknown => (typeof v === "string" ? fix(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === "url" || k === "symbol" ? x : walk(x)])) : v);
  return walk(value) as T;
}

/** Pure: the symbols a card's gate notes say were corrected ("ticker corrected ERJ → EMBJ: ..."), old to new. */
export function correctedTickers(gateNotes: string[]): Array<{ from: string; to: string }> {
  return gateNotes.flatMap((n) => { const m = /ticker corrected ([A-Z.]{1,7}) → ([A-Z.]{1,7})/.exec(n); return m ? [{ from: m[1], to: m[2] }] : []; });
}
