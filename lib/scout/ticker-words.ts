/** Server side: which capitalised words in AI-written text are real tickers, and which have a scout card (for linking). */
import { listings } from "./symbol-search";
import { latestCardIds } from "./store";

export async function tickersIn(texts: string[], extra: string[] = []): Promise<{ known: Set<string>; cards: Map<string, number> }> {
  const words = [...new Set([...texts.join("\n").match(/\b[A-Z]{1,5}(?:\.[A-Z])?\b/g) ?? [], ...extra])];
  const [list, cards] = await Promise.all([listings().catch(() => []), latestCardIds(words).catch(() => new Map<string, number>())]);
  const listed = new Set(list.map((l) => l.s));
  return { known: new Set([...words.filter((w) => listed.has(w)), ...extra, ...cards.keys()]), cards };
}
