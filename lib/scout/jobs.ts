/**
 * Background jobs that need their own time limit (5 minutes each): the stories cron starts them by calling their
 * route with CRON_SECRET and does not wait. A lock per job makes "at most once every N minutes".
 */
import * as store from "./store";

/** `rev`: raise it to make the job run once right after a deploy instead of waiting out its interval (used when its rules change). */
export const JOBS = {
  filingdiff: { everyMin: 30, about: "filing changes (10-K / 10-Q vs a year earlier)" },
  crowding: { everyMin: 15, about: "crowding for open cards (weekdays)" },
  readthrough: { everyMin: 20, about: "supply-chain read-through after capex raises" },
  bubbles: { everyMin: 120, rev: 2, about: "Bubbles: fixed-date events with a run-up into them, and what happened after" },
  sitewatch: { everyMin: 30, about: "quiet edits to the websites of open-card companies" },
  evidence: { everyMin: 10, about: "saving cited web pages to the Wayback Machine" },
  topnews: { everyMin: 30, about: "News tab: the ten most important stories of the last 24 hours" },
  sttrending: { everyMin: 10, about: "Stocktwits' trending ten at 9 AM and 3 PM ET" },
  listings: { everyMin: 180, about: "cards written before their stock listed (IPOs): start the paper track once it trades" },
  petitions: { everyMin: 360, rev: 2, about: "FDA citizen petitions on regulations.gov (short sellers' weekly)" },
  fdaletters: { everyMin: 360, about: "Pharma: the FDA's published rejection letters (openFDA), with what it faulted; a new one on your stocks is pushed" },
  panelwatch: { everyMin: 120, about: "Pharma: the advisory panel's vote (from the latest 10-Q or 10-K) and the crowd, for stocks with an FDA decision coming" },
  panelstudy: { everyMin: 360, about: "the FDA panel-vote study: prices each vote on file (about a minute), again weekly" },
  upgrades: { everyMin: 15, about: "Drift: broker upgrades to a buy rating, each a paper long from the moment it appears (no card)" },
  driftlist: { everyMin: 10, about: "Drift: a paper short for every setup from the moment it first appeared on the list (no card), and the entries and exits that are due" },
  preearnings: { everyMin: 60, about: "Calendar: warning signs on stocks reporting in the next five sessions (slide, unexplained drop, filing change, short idea, fall through takeover talk), and the reaction after each report" },
  prdesk: { everyMin: 4, about: "Press releases: new headlines from the wires and the news stream in the two daily windows, and each one's results an hour later and at the next two closes" },
  filingcheck: { everyMin: 5, about: "Story desk: the SEC's live 8-K list every five minutes; a material filing not read yet goes to the desk at once, without waiting for the 45-minute scan" },
  longterm: { everyMin: 10, about: "Long term: the 3,000 largest listed companies checked against their own annual reports (return on equity, steady profit, growth, debt, cash, margin, dilution), a few hundred a pass, each again monthly" },
  watchlist: { everyMin: 720, about: "Watch-list upkeep: the scout's terms that are not terms (over four words, a card's title) and its quiet ones retire; at most 60 stay active" },
  earningsrepair: { everyMin: 10, about: "Earnings drift: rows an older scan measured a day late are measured again on the report day, 60 a pass until none are left" },
  pricecheck: { everyMin: 60, about: "Scoreboard: splits since each paper entry, and entries or closes that fail the price check (\"price unverified\")" },
  ratingstudy: { everyMin: 5, about: "the downgrade study (2019 to mid-2025): reads the news history in 4-minute passes until done, then does nothing" },
} as const satisfies Record<string, { everyMin: number; about: string; rev?: number }>;
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
