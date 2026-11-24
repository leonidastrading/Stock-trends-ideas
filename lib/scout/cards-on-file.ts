/** The scout's existing cards on a stock, shown while a ticker is typed (Research tab). No imports: used in the browser too. */
export interface CardOnFile { id: number; createdAt: string; status: string; direction: "long" | "short"; primaryTicker: string; tickers: string[]; title: string }
export interface OnFile { id: number; createdAt: string; status: string; direction: "long" | "short"; title: string; /** False when the stock is one of the card's other tickers. */ primary: boolean }

/** Pure: the tickers in what was typed ("orcl, $crwv KGS" → ORCL, CRWV, KGS), at most five. */
export function typedTickers(typed: string): string[] {
  return [...new Set(typed.toUpperCase().split(/[\s,]+/).map((s) => s.replace(/^\$/, "")).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)))].slice(0, 5);
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
