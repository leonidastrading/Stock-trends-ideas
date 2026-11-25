/**
 * Background jobs that need their own time limit (5 minutes each): the stories cron starts them by calling their
 * route with CRON_SECRET and does not wait. A lock per job makes "at most once every N minutes".
 */
import * as store from "./store";

export const JOBS = {
  filingdiff: { everyMin: 30, about: "filing changes (10-K / 10-Q vs a year earlier)" },
  crowding: { everyMin: 15, about: "crowding for open cards (weekdays)" },
  readthrough: { everyMin: 20, about: "supply-chain read-through after capex raises" },
  bubbles: { everyMin: 120, about: "Bubbles: fixed-date events with a run-up into them, and what happened after" },
  sitewatch: { everyMin: 30, about: "quiet edits to the websites of open-card companies" },
  evidence: { everyMin: 10, about: "saving cited web pages to the Wayback Machine" },
  topnews: { everyMin: 30, about: "News tab: the ten most important stories of the last 24 hours" },
  sttrending: { everyMin: 10, about: "Stocktwits' trending ten at 9 AM and 3 PM ET" },
  listings: { everyMin: 180, about: "cards written before their stock listed (IPOs): start the paper track once it trades" },
  petitions: { everyMin: 360, about: "FDA citizen petitions on regulations.gov (short sellers' weekly)" },
  fdaletters: { everyMin: 360, about: "Pharma: the FDA's published rejection letters (openFDA), with what it faulted; a new one on your stocks is pushed" },
  panelwatch: { everyMin: 120, about: "Pharma: the advisory panel's vote (from the latest 10-Q or 10-K) and the crowd, for stocks with an FDA decision coming" },
  panelstudy: { everyMin: 360, about: "the FDA panel-vote study: prices each vote on file (about a minute), again weekly" },
  ratingstudy: { everyMin: 5, about: "the downgrade study (2019 to mid-2025): reads the news history in 4-minute passes until done, then does nothing" },
} as const;
export type JobName = keyof typeof JOBS;

/** Start a job unless it ran in the last `everyMin` minutes. Returns whether it was started. */
export async function startJob(origin: string, path: string, lockKey: string, everyMin: number, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!(await store.tryLock(lockKey, everyMin))) return false;
  const secret = env.CRON_SECRET?.trim();
  // Not awaited to the end: the job runs in that call's own time limit; this only starts it.
  void fetch(`${origin}${path}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}
