/** Refresh the dashboard panel caches from housekeeping, so page views rarely wait on outside calls. */
import { marketDataFromEnv } from "../alpaca";
import { breadthPanel, buzzPanel, contractsPanel, earningsPanel, marketRows, panel, polymarketPanel } from "../market/panels";
import { moversPanel, socialPanel } from "../market/social";

export const PANEL_AGE_MIN = { market: 15, earnings: 180, contracts: 180, buzz: 30, breadth: 60, polymarket: 15, movers: 10, social: 15 } as const;

export async function loadPanels(now = new Date()) {
  const data = marketDataFromEnv();
  const [market, earnings, contracts, buzz, breadth, polymarket, movers, social] = await Promise.all([
    panel("market", PANEL_AGE_MIN.market, () => marketRows(data, now)),
    panel("earnings", PANEL_AGE_MIN.earnings, () => earningsPanel(now)),
    panel("contracts", PANEL_AGE_MIN.contracts, () => contractsPanel(now, process.env.SEC_USER_AGENT?.trim())),
    panel("buzz", PANEL_AGE_MIN.buzz, () => buzzPanel()),
    panel("breadth", PANEL_AGE_MIN.breadth, () => breadthPanel(now)),
    panel("polymarket", PANEL_AGE_MIN.polymarket, () => polymarketPanel()),
    panel("movers", PANEL_AGE_MIN.movers, () => moversPanel(now, data)),
    panel("social", PANEL_AGE_MIN.social, () => socialPanel(now), 20_000),
  ]);
  return { market, earnings, contracts, buzz, breadth, polymarket, movers, social };
}

export async function warmPanels(now = new Date()): Promise<Record<string, string>> {
  const p = await loadPanels(now);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.error ? `error: ${v.error}` : "ok"]));
}
