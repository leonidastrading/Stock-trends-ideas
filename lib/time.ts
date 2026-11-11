/** Pure America/New_York time helpers; DST comes from the platform tz database. */

export const ET_TZ = "America/New_York";

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});

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
