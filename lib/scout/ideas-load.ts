/** Shared loader for the Scoring and Scoreboard pages: tracked cards → idea results, marked with recorded bars. */
import { UNIVERSE } from "@/config/universe";
import { addDays, toEt } from "@/lib/time";
import { ideaResult, type IdeaResult } from "./scoring";
import * as store from "./store";
import { groupBars } from "./tracking";

export async function loadIdeas(cards: store.StoredCard[], tracks: store.Track[]): Promise<IdeaResult[]> {
  const byCard = new Map(cards.map((c) => [c.id, c]));
  const mine = tracks.filter((t) => byCard.has(t.cardId) && t.entryDate);
  const earliest = mine.map((t) => t.entryDate!).sort()[0];
  if (!earliest) return [];
  const symbols = [...new Set([...mine.flatMap((t) => [t.symbol, "SPY", t.sectorEtf]), ...cards.flatMap((c) => UNIVERSE[c.sector as keyof typeof UNIVERSE] ?? [])])];
  const bars = groupBars(await store.loadBars(symbols, addDays(earliest, -3), toEt(new Date()).date));
  return mine.map((t) => ideaResult(byCard.get(t.cardId)!, t, bars)).filter((x): x is IdeaResult => x !== null);
}
