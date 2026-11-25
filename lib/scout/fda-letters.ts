/**
 * The FDA's rejection letters on the Pharma tab: every letter the FDA has published for a drug still unapproved,
 * matched to a US ticker where the company is listed, with what the FDA faulted in its own headings. A new letter on
 * a stock with a card or on the watch-list is pushed to the phone. No AI. (lib/sources/fda-letters.ts reads them.)
 */
import { secTickerList } from "../sources/edgar";
import { fetchFdaLetters, verdictLabel, type FdaLetter } from "../sources/fda-letters";
import { sponsorMatcher } from "../sources/pharma";
import * as store from "./store";

export const FDA_LETTERS = { key: "fda:letters", keepDays: 730, alertDays: 45 };

export interface ListedLetter extends FdaLetter { symbol: string | null }
export interface FdaLetterWatch { at: string; lastUpdated: string | null; letters: ListedLetter[] }

/** Pure: letters matched to tickers by company name (unlisted and foreign companies keep a null symbol). */
export function withSymbols(letters: FdaLetter[], match: (company: string) => string | null): ListedLetter[] {
  return letters.map((l) => ({ ...l, symbol: match(l.company) }));
}

/** Pure: a letter as one line for a phone alert or a research brief. */
export function letterLine(l: ListedLetter): string {
  return `FDA rejection letter dated ${l.date} to ${l.company}${l.application ? ` (${l.application})` : ""}: the FDA ${verdictLabel(l.verdict)}${l.faults.length ? ` [${l.faults.join(", ")}]` : ""}.${l.quote ? ` In its words: "${l.quote.slice(0, 280)}"` : ""}`;
}

export async function fdaLetterWatch(): Promise<FdaLetterWatch | null> {
  return (await store.cacheGet<FdaLetterWatch>(FDA_LETTERS.key).catch(() => null))?.data ?? null;
}

/** One pass: read the letters, match tickers, alert on new ones for your stocks (the first run only fills the list). */
export async function runFdaLetters(env: NodeJS.ProcessEnv = process.env, now = new Date(), fetchImpl?: typeof fetch): Promise<string> {
  const prev = await fdaLetterWatch();
  const { letters, lastUpdated } = await fetchFdaLetters(fetchImpl);
  if (!letters.length) return "fda letters: none returned";
  const ua = env.SEC_USER_AGENT?.trim();
  const match = ua ? sponsorMatcher(await secTickerList(ua, fetchImpl).catch(() => [])) : () => null;
  const cutoff = new Date(now.getTime() - FDA_LETTERS.keepDays * 86400_000).toISOString().slice(0, 10);
  const listed = withSymbols(letters.filter((l) => l.date >= cutoff), match);
  await store.cachePut(FDA_LETTERS.key, { at: now.toISOString(), lastUpdated, letters: listed } satisfies FdaLetterWatch);
  const pushed = await alerts(prev, listed, env, now, fetchImpl).catch(() => 0);
  const by = (v: FdaLetter["verdict"]) => listed.filter((l) => l.verdict === v).length;
  return `fda letters: ${listed.length} rejection letters since ${cutoff} (${listed.filter((l) => l.symbol).length} on US-listed companies; ${by("clinical")} clinical, ${by("fixable")} manufacturing or factory, ${by("studies")} other studies, ${by("unclear")} unread), newest ${listed[0]?.date ?? "none"}, FDA set updated ${lastUpdated ?? "?"}${pushed ? `, ${pushed} alerts` : ""}`;
}

async function alerts(prev: FdaLetterWatch | null, letters: ListedLetter[], env: NodeJS.ProcessEnv, now: Date, fetchImpl?: typeof fetch): Promise<number> {
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured(env) || !prev) return 0;
  const seen = new Set(prev.letters.map((l) => l.key));
  const recent = new Date(now.getTime() - FDA_LETTERS.alertDays * 86400_000).toISOString().slice(0, 10);
  const fresh = letters.filter((l) => l.symbol && !seen.has(l.key) && l.date >= recent);
  if (!fresh.length) return 0;
  const [cards, watch] = await Promise.all([store.cardsSince(120).catch(() => []), store.watchlist("active").catch(() => [])]);
  const mine = new Set([...cards.flatMap((c) => c.card.tickers.map((t) => t.symbol)), ...watch.flatMap((w) => w.tickers)]);
  const base = env.DASHBOARD_URL?.replace(/\/$/, "");
  let n = 0;
  for (const l of fresh.filter((x) => mine.has(x.symbol!))) {
    const title = `FDA's rejection letter to ${l.symbol} is public: ${l.verdict === "fixable" ? "manufacturing, fixable" : l.verdict === "clinical" ? "clinical evidence" : l.verdict === "studies" ? "more studies" : "see the letter"}`;
    if (!(await store.claimNotification(`fda-letter:${l.key}`, title))) continue;
    await sendPush({ title, message: letterLine(l).slice(0, 450), tags: ["page_facing_up"], priority: 3, click: base ? `${base}/pharma#fda-letters` : "https://open.fda.gov/apis/transparency/completeresponseletters/" }, env, fetchImpl);
    n++;
  }
  return n;
}
