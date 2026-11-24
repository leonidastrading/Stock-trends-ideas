/** The scout's existing cards on a stock, shown while a ticker is typed (Research tab). No imports: used in the browser too. */
export interface CardOnFile { id: number; createdAt: string; status: string; direction: "long" | "short"; primaryTicker: string; tickers: string[]; title: string }
export interface OnFile { id: number; createdAt: string; status: string; direction: "long" | "short"; title: string; /** False when the stock is one of the card's other tickers. */ primary: boolean }

/** Pure: the tickers in what was typed ("orcl, $crwv KGS" → ORCL, CRWV, KGS), at most `max` (five: what one research takes). */
export function typedTickers(typed: string, max = 5): string[] {
  return [...new Set(typed.toUpperCase().split(/[\s,;]+/).map((s) => s.replace(/^\$/, "")).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)))].slice(0, max);
}

/** The most stocks one list lookup takes. */
export const LIST_MAX = 40;

/**
 * Pure: the tickers when what was typed in a search box is a list of them, else null (a single ticker, a company
 * name or a card number is not a list). A list has commas ("AFRM, CAKE, FXI"), or is three or more tickers typed in
 * capitals ("AFRM CAKE FXI"): lower-case words such as "bank of america" stay a company search.
 */
export function tickerList(typed: string): string[] | null {
  const t = typed.trim();
  const tokens = t.split(/[\s,;]+/).filter(Boolean);
  // Every word has to be a ticker: one that is not (a name, a number) makes it an ordinary search.
  const every = typedTickers(t, Infinity);
  if (every.length < 2 || every.length !== new Set(tokens.map((x) => x.replace(/^\$/, "").toUpperCase())).size) return null;
  const all = every.slice(0, LIST_MAX);
  if (/[,;]/.test(t)) return all;
  return all.length >= 3 && t === t.toUpperCase() ? all : null;
}

/** Pure: each symbol's cards, newest first, cards on the stock itself before cards that only mention it. */
export function cardsBySymbol(cards: CardOnFile[], symbols: string[]): Record<string, OnFile[]> {
  const out: Record<string, OnFile[]> = {};
  for (const s of symbols) {
    out[s] = cards
      .filter((c) => c.primaryTicker === s || c.tickers.includes(s))
      .map((c) => ({ id: c.id, createdAt: c.createdAt, status: c.status, direction: c.direction, title: c.title, primary: c.primaryTicker === s }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || b.createdAt.localeCompare(a.createdAt));
  }
  return out;
}
