/** Pure America/New_York time helpers; DST comes from the platform tz database. */

export const ET_TZ = "America/New_York";

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});

const etShort = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const etClock = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, hour: "numeric", minute: "2-digit" });

/** A timestamp as people read it, in New York time: "Nov 14, 3:50 PM ET" (clockOnly: "3:50 PM ET"). */
export function etLabel(iso: string | Date, clockOnly = false): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${(clockOnly ? etClock : etShort).format(d)} ET`;
}

export interface EtParts {
  date: string;
  hhmm: string;
  minutes: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toEt(d: Date): EtParts {
  const parts: Record<string, string> = {};
  for (const p of etFormatter.formatToParts(d)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

/** Add calendar days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** ISO week key "YYYY-Www" (Monday-based), for once-a-week jobs. */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface Session {
  date: string;
  open: string;
  close: string;
}

/** Normalize Alpaca /v2/calendar rows ("0930" or "09:30"). */
export function parseCalendar(rows: Array<{ date: string; open: string; close: string }>): Session[] {
  const norm = (t: string) => (t.includes(":") ? t.slice(0, 5) : `${t.slice(0, 2)}:${t.slice(2, 4)}`);
  return rows.map((r) => ({ date: r.date, open: norm(r.open), close: norm(r.close) })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The first session strictly after `date` (YYYY-MM-DD), or undefined if the calendar ends first. */
export function nextSession(sessions: Session[], date: string): Session | undefined {
  return sessions.find((s) => s.date > date);
}

const shortFmt = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Nov 13, 2:14 PM ET" for an ISO timestamp. */
export function fmtEt(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "" : `${shortFmt.format(d)} ET`;
}

/**
 * How long ago (or how far ahead): "just now", "25m ago" under an hour, "3h ago" under a day, then "2 days ago" by
 * calendar day (US Eastern); "in 40m", "in 3h", "in 5 days" for the future.
 */
export function ago(iso: string | Date, now = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const ms = now.getTime() - d.getTime();
  const min = Math.floor(Math.abs(ms) / 60000);
  if (min < 1) return "just now";
  const days = Math.abs(daysBetween(toEt(d).date, toEt(now).date));
  // Under a day is always in hours, also across midnight (a card from 10 PM read at midnight is "1h ago", not "1 day ago").
  const span = min < 60 ? `${min}m` : min < 24 * 60 ? `${Math.floor(min / 60)}h` : `${days} day${days === 1 ? "" : "s"}`;
  return ms < 0 ? `in ${span}` : `${span} ago`;
}

/** For a calendar date (YYYY-MM-DD): "today", "1 day ago", "in 3 days". */
export function dayAgo(date: string, now = new Date()): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return "";
  const n = daysBetween(date.slice(0, 10), toEt(now).date);
  return n === 0 ? "today" : n > 0 ? `${n} day${n === 1 ? "" : "s"} ago` : `in ${-n} day${n === -1 ? "" : "s"}`;
}

/** "Nov 16, 2:01 PM ET · 3 days ago". */
export function fmtEtAgo(iso: string | Date, now = new Date()): string {
  const s = fmtEt(iso);
  return s ? `${s} · ${ago(iso, now)}` : "";
}

/** etLabel with how long ago. */
export function etLabelAgo(iso: string | Date, clockOnly = false, now = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "" : `${etLabel(d, clockOnly)} · ${ago(d, now)}`;
}
