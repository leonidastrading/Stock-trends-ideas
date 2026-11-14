/** Refresh the dashboard panel caches from housekeeping, so page views rarely wait on outside calls. */
import { marketDataFromEnv } from "../alpaca";
import { breadthPanel, buzzPanel, contractsPanel, earningsPanel, marketRows, panel } from "../market/panels";

export const PANEL_AGE_MIN = { market: 15, earnings: 180, contracts: 180, buzz: 30, breadth: 60 } as const;

export async function loadPanels(now = new Date()) {
  const data = marketDataFromEnv();
  const [market, earnings, contracts, buzz, breadth] = await Promise.all([
    panel("market", PANEL_AGE_MIN.market, () => marketRows(data, now)),
    panel("earnings", PANEL_AGE_MIN.earnings, () => earningsPanel(now)),
    panel("contracts", PANEL_AGE_MIN.contracts, () => contractsPanel(now, process.env.SEC_USER_AGENT?.trim())),
    panel("buzz", PANEL_AGE_MIN.buzz, () => buzzPanel()),
    panel("breadth", PANEL_AGE_MIN.breadth, () => breadthPanel(now)),
  ]);
  return { market, earnings, contracts, buzz, breadth };
}

export async function warmPanels(now = new Date()): Promise<Record<string, string>> {
  const p = await loadPanels(now);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.error ? `error: ${v.error}` : "ok"]));
}
