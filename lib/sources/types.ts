import type { Kind } from "@/config/scout";

/** One measurement from one source: value now, the comparable 12-month base, and the change. */
export interface Signal {
  source: string;
  metric: string;
  value: number;
  /** Comparable 12-month base supplied by the source itself (null = unknown; the scan fills it from stored history). */
  baseline: number | null;
  /** value / baseline − 1 */
  changeVs12m: number | null;
  /** YYYY-MM-DD the value is as of */
  asOf: string;
  /** One line a person (or the model) can read. Numbers and dates only, no interpretation. */
  note: string;
  /** Anything the model may need: top items, urls, counts. Kept small. */
  detail?: Record<string, unknown>;
}

export type SourceStatus = "ok" | "down" | "missing" | "capped";

export interface SourceResult {
  source: string;
  status: SourceStatus;
  detail?: string;
  signals: Signal[];
}

export interface ProbeContext {
  term: string;
  kind: Kind | null;
  tickers: string[];
  now: Date;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface Source {
  id: string;
  label: string;
  /** What this source is good at (shown on the health panel). */
  about: string;
  /** False = no key or no data source: reported as "missing", never as "down". */
  configured(env: NodeJS.ProcessEnv): boolean;
  probe(ctx: ProbeContext): Promise<SourceResult>;
}

export const r1 = (x: number) => Math.round(x * 10) / 10;
export const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`);
export const change = (value: number, baseline: number | null): number | null => (baseline && baseline > 0 ? value / baseline - 1 : null);
export const dateStr = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (now: Date, n: number) => new Date(now.getTime() - n * 86400000);

/** Wrap a probe so a network failure becomes status "down" with the error text, never a throw. */
export async function guarded(id: string, fn: () => Promise<SourceResult>): Promise<SourceResult> {
  try {
    return await fn();
  } catch (err) {
    return { source: id, status: "down", detail: err instanceof Error ? err.message.slice(0, 300) : String(err), signals: [] };
  }
}
