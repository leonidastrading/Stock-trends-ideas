/**
 * The chatter test (an experiment, not part of a card's evidence): does a spike
 * in Stocktwits chatter while the price is still quiet predict the move?
 * Fixed in advance so popularity cannot choose the stocks afterwards: the first
 * 18 names of each sector in the baseline universe (198 stocks).
 */
import { SECTORS, type Sector } from "./scout";
import { UNIVERSE } from "./universe";

export const CHATTER = {
  perSector: 18,
  /** Symbols measured per call; the hourly story cron, the midday scan and the after-close job each take the next batch. */
  batch: 50,
  /** Spike: today's log message rate at least this many standard deviations above the symbol's own trailing days. */
  spikeZ: 2.5,
  lookbackDays: 60,
  minHistory: 20,
  /** A spike only counts as a new episode if the symbol had none in the previous days. */
  episodeGapDays: 5,
  /** Quiet price: the 5 sessions before the spike moved less than this against SPY (percent, either way). */
  quietPct: 3,
  /** Bullish / bearish chatter: share of sentiment-tagged messages. */
  bullishShare: 0.6,
  bearishShare: 0.4,
  /** About 1 in 40 ordinary symbol-days becomes a control, chosen by a hash of date and symbol (no hindsight). */
  controlOneIn: 40,
  horizons: [1, 5, 20] as const,
};

export const CHATTER_UNIVERSE: Array<{ symbol: string; sector: Sector; etf: string }> = (Object.keys(UNIVERSE) as Sector[]).flatMap((sector) =>
  UNIVERSE[sector].slice(0, CHATTER.perSector).map((symbol) => ({ symbol, sector, etf: SECTORS[sector] })),
);
