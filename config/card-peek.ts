/**
 * Cards to write into the server log once, so a coding session can read them when asked to compare or review cards
 * (it cannot open the site or the database, only the deployment's logs). Change the ids and raise the revision:
 * the next scheduler call logs each card once. Empty lists log nothing. With `symbols`, what the scout did on those
 * stocks is logged too (to answer "why was there no card on X"). The log is the Vercel project's own.
 */
export const CARD_PEEK = {
  rev: 7, ids: [] as number[],
  /** Also log every earnings-drift row that was measured again on the report day (first numbers against corrected ones). */
  earningsFixes: false,
  /** Stocks to look up instead of card numbers: every card, research attempt and story-desk read on them in the last `days` days, a line each. */
  symbols: ["TSLA", "VRTX", "MO", "COST", "PATH"] as string[], days: 3,
};
