/**
 * What the topic sources search for. A research term that is only a ticker ("TXN" from Home search) is not a topic:
 * Wikipedia found "TX Network" for it, and Google Trends, YouTube and Hacker News measured the letters. For a bare
 * ticker the sources are given the company's name instead; any other term is searched as typed.
 */
import type { ProbeContext } from "../sources/types";
import { searchableName } from "./company-match";
import * as store from "./store";

/** Pure: whether a term is just the stock's ticker ("TXN", "$txn"). */
export function isBareTicker(term: string, tickers: string[]): boolean {
  const t = term.trim().replace(/^\$/, "");
  return /^[A-Za-z][A-Za-z.]{0,5}$/.test(t) && tickers.some((x) => x.toUpperCase() === t.toUpperCase());
}

/** Pure: a listing's name as people search for it ("Texas Instruments Incorporated Common Stock" → "Texas Instruments"). */
export function searchName(name: string): string {
  let n = name.replace(/\s+/g, " ").trim()
    .replace(/\s*[-–,]?\s*\b(?:class [a-c]\b.*|common stock.*|common shares.*|ordinary shares.*|american depositary (?:shares?|receipts?).*|depositary shares.*|units?\b.*|warrants?\b.*)$/i, "");
  // Corporate endings, however many are stacked ("Holdings, Inc.").
  for (let i = 0; i < 3; i++) n = n.replace(/[,.]?\s+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|l\.p|lp|n\.v|nv|s\.a|sa|ag|se|holdings?|group)\.?$/i, "");
  return n.replace(/^the\s+/i, "").trim();
}

/** Pure: the ticker a desk's label is about ("insider: OPAL", "stocktwits: HUBS trending 2026-11-26"), when the label is only the desk and the ticker. */
export function labelTicker(term: string, tickers: string[]): string | null {
  const m = /^[a-z][a-z+ ]{2,24}:\s*\$?([A-Za-z][A-Za-z.]{0,5})\b/.exec(term.trim());
  if (!m || /^story\b|^inbox\b|^dots?\b|^theme/i.test(term)) return null;
  return tickers.find((x) => x.toUpperCase() === m[1].toUpperCase()) ?? null;
}

/**
 * The subject the sources should measure for this research: the company's name for a bare ticker or a desk's label on
 * one ticker, else the term as typed. When the name cannot be searched for (one short acronym or one ordinary word, or
 * no name on file), the search sources are not asked at all.
 */
export async function probeSubject(term: string, tickers: string[]): Promise<Pick<ProbeContext, "term" | "names" | "subject">> {
  const bare = isBareTicker(term, tickers);
  const symbol = bare ? tickers.find((x) => x.toUpperCase() === term.trim().replace(/^\$/, "").toUpperCase())! : labelTicker(term, tickers);
  if (!symbol) return { term };
  const name = (await store.symbolInfo([symbol]).catch(() => new Map<string, store.SymbolInfo>())).get(symbol)?.name ?? null;
  const clean = name && !/not a listed symbol/i.test(name) ? searchName(name) : "";
  if (clean.length >= 3 && searchableName(name)) return { term: clean, names: { [symbol]: name! }, subject: "company" };
  // A name on file that cannot be searched for: the letters would measure something else.
  if (clean) return { term, names: { [symbol]: name! }, subject: "unusable" };
  // No name on file: searched as typed, as before.
  return { term };
}
