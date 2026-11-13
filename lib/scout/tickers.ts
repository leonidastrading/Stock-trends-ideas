/** Normalise a model-supplied ticker: "$brk-b " -> "BRK.B". Null when it is not a US symbol. */
export const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

export function normalizeTicker(raw: string): string | null {
  const t = raw.trim().toUpperCase().replace(/^\$/, "").replace(/-/g, ".").replace(/\s+/g, "");
  return TICKER_RE.test(t) ? t : null;
}
