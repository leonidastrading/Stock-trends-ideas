/**
 * Quiet hours, so the database (Neon, billed by the hour it is awake) can sleep: the frequent scheduled jobs
 * (news alerts every minute, stories every 5 minutes, Trump posts, chatter) do nothing from 8 PM to 6 AM ET every
 * day, and on weekends run only once an hour. Neon suspends after 5 idle minutes. Nothing is lost: news, posts and
 * filings are read from their feeds on the next run, and anything the AI budget turned away waits in the catch-up
 * queue. Pages still work at any hour (the database wakes in under a second). ?force=1 runs a job anyway;
 * QUIET_HOURS=off (in Vercel) turns quiet hours off altogether.
 */
import { toEt } from "./time";

export const QUIET = { sleepFrom: 20 * 60, wakeAt: 6 * 60, label: "8 PM–6 AM ET" };

export type Gate = { run: true } | { run: false; why: string };

/**
 * Pure: may a scheduled job run now? `cadence` is how often the scheduler calls it: every minute (runs in the first
 * 2 minutes of the hour on weekends) or every few minutes (runs in the first 5).
 */
export function quietGate(now: Date, cadence: "minute" | "minutes"): Gate {
  const et = toEt(now);
  if (et.minutes >= QUIET.sleepFrom || et.minutes < QUIET.wakeAt) return { run: false, why: `asleep ${QUIET.label} (the database sleeps; ?force=1 runs anyway)` };
  const weekend = et.weekday === 0 || et.weekday === 6;
  if (weekend && et.minutes % 60 >= (cadence === "minute" ? 2 : 5)) return { run: false, why: "weekend: once an hour (?force=1 runs anyway)" };
  return { run: true };
}

/** For a cron route: null to go ahead, or the reply that says why it is resting. */
export function quietReply(request: Request, cadence: "minute" | "minutes", now = new Date()): { status: "asleep"; reason: string } | null {
  if (new URL(request.url).searchParams.get("force") === "1" || process.env.QUIET_HOURS === "off") return null;
  const g = quietGate(now, cadence);
  return g.run ? null : { status: "asleep", reason: g.why };
}
