/**
 * Trend scout: frozen rules. These constants are part of each version's hash
 * (see lib/scout/version.ts). Changing one starts a new version.
 */

export const KINDS = ["consumer", "platform", "second_order", "rerating", "event"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  consumer: "consumer",
  platform: "platform",
  second_order: "second-order",
  rerating: "re-rating",
  event: "event",
};

export const SCOUT = {
  defaultModel: "claude-opus-5-5",
  defaultEffort: "high" as const,
  /** Daily LLM spend cap, USD. Settings can lower it; the scout stops for the day when it is hit. */
  defaultDailyCapUsd: 5,
  /** Candidates researched per daily scan, at most. */
  maxCandidatesPerScan: 5,
  /** A term is not researched again within this many days. */
  candidateCooldownDays: 7,
  /** A term is a scan candidate when at least this many sources accelerate... */
  minAcceleratingSources: 2,
  /** ...by at least this fraction against their 12-month base. */
  minChangeVs12m: 0.5,
  /** Event kind: Polymarket odds moving by this many points in 7 days is a candidate on its own. */
  minOddsMovePoints: 10,

  // ----- gates (enforced by code, never by the model)
  /** Materiality: a line under this share of revenue with no estimate is logged, not promoted. */
  minRevenueSharePct: 10,
  /** Lateness: either of these marks the idea already obvious. */
  lateStockMove30dPct: 30,
  lateNewsStories30d: 20,

  // ----- paper tracking
  /** Entry is the next regular-session open after the card. */
  defaultTimeLimitDays: 90,
  maxTimeLimitDays: 180,
  /** Random-sector baseline: stocks drawn per idea. */
  baselineDraws: 20,
  /** Verdict: after this many closed promoted ideas or this many months, whichever is later. */
  verdictClosedIdeas: 30,
  verdictMonths: 6,
  verdictPercentile: 0.9,

  // ----- digest
  digestCards: 5,
  /** Mainstream outlets counted for the lateness gate (news stream `source` or url host). */
  mainstreamHosts: [
    "reuters.com", "bloomberg.com", "wsj.com", "ft.com", "cnbc.com", "nytimes.com", "washingtonpost.com", "apnews.com",
    "barrons.com", "marketwatch.com", "forbes.com", "businessinsider.com", "theverge.com", "techcrunch.com", "axios.com",
    "benzinga.com", "yahoo.com", "fool.com", "seekingalpha.com", "investors.com", "economist.com", "theguardian.com", "bbc.com",
  ],
};

/** Approximate list prices, $ per million tokens. Update if prices change. */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function callCost(model: string, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25;
  return Math.round(((inTok * p.input + (usage.cache_read_input_tokens ?? 0) * p.cacheRead + (usage.output_tokens ?? 0) * p.output) / 1e6) * 1e4) / 1e4;
}

/** GICS sectors and the SPDR sector fund each idea is measured against. */
export const SECTORS = {
  technology: "XLK",
  communication: "XLC",
  consumer_discretionary: "XLY",
  consumer_staples: "XLP",
  health_care: "XLV",
  financials: "XLF",
  industrials: "XLI",
  energy: "XLE",
  materials: "XLB",
  utilities: "XLU",
  real_estate: "XLRE",
} as const;
export type Sector = keyof typeof SECTORS;
export const SECTOR_KEYS = Object.keys(SECTORS) as Sector[];

/** Watch-list terms the scout starts with. Vadim's additions live in the database. */
export const SEED_WATCHLIST: Array<{ term: string; kind: Kind; tickers: string[] }> = [
  { term: "data center power demand", kind: "second_order", tickers: ["VRT", "ETN", "GEV", "PWR"] },
  { term: "grid transformer shortage", kind: "second_order", tickers: ["HUBB", "ETN", "ABB"] },
  { term: "GLP-1 weight loss", kind: "consumer", tickers: ["LLY", "NVO", "HIMS"] },
  { term: "AI coding assistant", kind: "platform", tickers: ["MSFT", "GTLB"] },
  { term: "robotaxi", kind: "platform", tickers: ["TSLA", "GOOGL", "UBER"] },
  { term: "nuclear power restart", kind: "second_order", tickers: ["CEG", "VST", "CCJ", "OKLO"] },
  { term: "satellite internet", kind: "platform", tickers: ["ASTS", "T", "VZ"] },
  { term: "prediction markets", kind: "platform", tickers: ["HOOD", "DKNG", "CME"] },
  { term: "tariff exemption semiconductors", kind: "event", tickers: ["NVDA", "AMD", "AVGO"] },
  { term: "Fed rate cut", kind: "event", tickers: ["SPY", "IWM", "XLF"] },
  { term: "cloud capex", kind: "rerating", tickers: ["ORCL", "AMZN", "MSFT"] },
  { term: "humanoid robot", kind: "second_order", tickers: ["TSLA", "ISRG", "ROK"] },
];
