/**
 * Background jobs that need their own time limit (5 minutes each): the stories cron starts them by calling their
 * route with CRON_SECRET and does not wait. A lock per job makes "at most once every N minutes".
 */
import * as store from "./store";

export const JOBS = {
  filingdiff: { everyMin: 30, about: "filing changes (10-K / 10-Q vs a year earlier)" },
  crowding: { everyMin: 15, about: "crowding for open cards (weekdays)" },
  readthrough: { everyMin: 20, about: "supply-chain read-through after capex raises" },
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
