/**
 * The mechanical rules' books, read for the Scoreboard: the Drift list (short every setup when it lists), Upgrades
 * (buy every upgrade to a buy rating when it appears) and earnings drift by the numbers (buy every A-setup). Open
 * trades are marked at the latest price. See rule-lines.ts for what a line means.
 */
import { marketDataFromEnv } from "../alpaca";
import { listBook, listResult } from "./drift-list";
import { pickedByModel, ruleLine, type RuleLine, type RuleResult } from "./rule-lines";
import { playerOf } from "./scoreboard";
import type { StoredCard } from "./store";
import { upgradeBook, upgradeResult } from "./upgrades";

export interface RuleRows { lines: RuleLine[]; picks: RuleLine[]; firstClose: string | null }

export async function ruleRows(cards: StoredCard[], termByCard: Map<number, string>): Promise<RuleRows> {
  const [list, ups, earn] = await Promise.all([
    listBook(400).catch(() => []), upgradeBook(400).catch(() => []),
    import("./earnings").then((e) => e.allTracks()).catch(() => []),
  ]);
  const data = marketDataFromEnv();
  const open = [...new Set([...list.filter((e) => e.entryDate && !e.exitDate).map((e) => e.symbol), ...ups.filter((u) => u.entryDate && !u.exitDate).map((u) => u.symbol)])];
  const snaps = (open.length && data?.getSnapshots ? await Promise.race([data.getSnapshots([...open, "SPY"]).catch(() => ({})), new Promise<Record<string, never>>((r) => setTimeout(() => r({}), 6000))]) : {}) as Record<string, { price: number }>;
  const spy = snaps.SPY?.price ?? null;
  const now = new Date();
  const listed = list.map((e) => { const r = listResult(e, snaps[e.symbol]?.price ?? null, spy, now); return { e, res: { vsSpy: r?.vsSpy ?? null, closed: !!e.exitDate } satisfies RuleResult }; });
  const upgraded: RuleResult[] = ups.map((u) => { const r = upgradeResult(u, snaps[u.symbol]?.price ?? null, spy, now); return { vsSpy: r?.vsSpy ?? null, closed: !!u.exitDate }; });
  const earnings: RuleResult[] = earn.map((t) => ({ vsSpy: t.closed && t.retPct !== null && t.spyPct !== null ? (t.retPct - t.spyPct) / 100 : null, closed: t.closed }));
  const driftCards = cards.filter((c) => playerOf(c.origin, termByCard.get(c.id)) === "scout_drift").map((c) => ({ symbol: c.primaryTicker, createdAt: c.createdAt }));
  const picked = listed.filter((x) => pickedByModel(x.e, driftCards)), passed = listed.filter((x) => !pickedByModel(x.e, driftCards));
  return {
    lines: [
      ruleLine("Down drift list", "Short every Drift setup at the price when it lists; cover after 28 days.", "short", listed.map((x) => x.res)),
      ruleLine("Broker upgrades", "Buy every upgrade to a buy rating (stock $5+, liquid) when it appears; sell after 84 days.", "long", upgraded),
      ruleLine("Earnings drift, by the numbers", "Buy every A-setup after its report; sell before the next one. Open trades are counted, not marked.", "long", earnings),
    ],
    picks: [
      ruleLine("Picked by the model", "Drift setups the down-drift desk also wrote a card on.", "short", picked.map((x) => x.res)),
      ruleLine("Passed on", "Drift setups it wrote no card on.", "short", passed.map((x) => x.res)),
    ],
    firstClose: list.filter((e) => e.exitBy && !e.exitDate).map((e) => e.exitBy!).sort()[0] ?? null,
  };
}
