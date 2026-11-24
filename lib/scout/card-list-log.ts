/**
 * One-off, at Vadim's request (Nov 24 2026): the card numbers for the tickers in his notebook, printed once to the
 * server log so the coding assistant can read them back to him. Card numbers and titles only; nothing secret.
 * Runs once (a marker in the cache), then does nothing. Safe to delete.
 */
import { cardsBySymbol } from "./cards-on-file";
import * as store from "./store";

const LIST = ["AFRM", "RMIX", "APC", "CAKE", "FXI", "LPCN", "PICS", "OTLY", "FTNT", "ALTG", "GPN", "QNT", "IONQ", "ASTS", "HII"];
const KEY = "cardlist:2026-11-24:a";

export async function logCardList(): Promise<void> {
  if (await store.cacheGet(KEY).catch(() => null)) return;
  await store.cachePut(KEY, { at: new Date().toISOString() });
  const by = cardsBySymbol(await store.cardsOnSymbols(LIST, 3650), LIST);
  for (const sym of LIST) {
    const rows = by[sym] ?? [];
    console.log(`card list ${sym}: ${rows.length ? rows.map((c) => `#${c.id} ${c.direction} ${c.status}${c.primary ? "" : " (other ticker)"} ${c.createdAt.slice(0, 10)} ${c.title.slice(0, 70)}`).join(" | ") : "none"}`);
  }
}
