/**
 * Cards to write into the server log once, so a coding session can read them when asked to compare or review cards
 * (it cannot open the site or the database, only the deployment's logs). Change the ids and raise the revision:
 * the next scheduler call logs each card once. Empty lists log nothing. With `symbols`, what the scout did on those
 * stocks is logged too (to answer "why was there no card on X"). The log is the Vercel project's own.
 */
export const CARD_PEEK = {
  rev: 2, ids: [] as number[],
  /** Stocks to look up instead of card numbers: every card, research attempt and story-desk read on them in the last `days` days, a line each. */
  symbols: ["SNY", "INSM"] as string[], days: 10,
};
