/** Writes the cards named in config/card-peek.ts to the server log, once per revision (see that file for why). */
import { CARD_PEEK } from "@/config/card-peek";
import { cardForApi } from "./card-api";
import { crowdingFor } from "./crowding";
import * as store from "./store";

/** Pure: a long text as numbered pieces short enough for one log line each. */
export function logPieces(label: string, text: string, size = 3000): string[] {
  const n = Math.max(1, Math.ceil(text.length / size));
  return Array.from({ length: n }, (_, i) => `${label} [${i + 1}/${n}] ${text.slice(i * size, (i + 1) * size)}`);
}

/** Pure: a card's JSON without the parts that only repeat or decorate (links, chart data), to keep the log short. */
export function slim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(slim);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k, v]) => v !== null && v !== "" && !/^(url|urls|links?|chart|logo|html)$/i.test(k)).map(([k, v]) => [k, slim(v)]));
}

export async function runCardPeek(origin: string, peek = CARD_PEEK): Promise<number> {
  if (!peek.ids.length) return 0;
  const key = `card-peek:${peek.rev}`;
  if (await store.cacheGet(key).catch(() => null)) return 0;
  await store.cachePut(key, { at: new Date().toISOString(), ids: peek.ids });
  let n = 0;
  for (const id of peek.ids) {
    const card = await store.getCard(id).catch(() => null);
    if (!card) { console.log(`card-peek #${id}: no such card`); continue; }
    const [track, crowd] = await Promise.all([store.getTrack(id).catch(() => null), crowdingFor([id]).then((m) => m.get(id) ?? null).catch(() => null)]);
    for (const line of logPieces(`card-peek #${id}`, JSON.stringify(slim(cardForApi(card, track, crowd, origin))))) console.log(line);
    n++;
  }
  return n;
}
