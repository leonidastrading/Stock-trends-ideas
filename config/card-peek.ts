/**
 * Cards to write into the server log once, so a coding session can read them when asked to compare or review cards
 * (it cannot open the site or the database, only the deployment's logs). Change the ids and raise the revision:
 * the next scheduler call logs each card once. An empty list logs nothing. The log is the Vercel project's own.
 */
export const CARD_PEEK = { rev: 1, ids: [363, 393] as number[] };
