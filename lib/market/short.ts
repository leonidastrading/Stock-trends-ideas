/**
 * Short interest: Nasdaq's per-stock short-interest history (exchanges publish it twice a month; the same public
 * site the earnings calendar comes from), plus Schwab's shares outstanding when Schwab is connected, for "% of
 * shares short". Schwab's own short-interest fields come back as zero, so zeros are treated as "no data".
 */
import { getText } from "../http";

const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "application/json, text/plain, */*" };

export interface ShortData {
  symbol: string;
  /** Shares sold short at the last settlement date, and the date. */
  interest: number | null; asOf: string | null;
  /** Change since the previous report, in %. */
  changePct: number | null;
  daysToCover: number | null;
  /** % of shares outstanding sold short (needs Schwab's shares outstanding). */
  pctOutstanding: number | null;
  squeeze: "high" | "elevated" | "normal" | null;
  source: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[,$%\s]/g, ""));
  return Number.isFinite(n) && v.trim() !== "" && v.trim() !== "N/A" ? n : null;
};

const isoDate = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** Pure: Nasdaq's short-interest reply → the latest report and the change since the one before (field names matched loosely). */
export function parseNasdaqShort(symbol: string, json: unknown): Omit<ShortData, "pctOutstanding" | "squeeze"> | null {
  const rows = findRows(json);
  if (!rows.length) return null;
  const pick = (r: Record<string, unknown>, re: RegExp) => Object.entries(r).find(([k]) => re.test(k))?.[1];
  const read = (r: Record<string, unknown>) => ({ date: isoDate(pick(r, /settlement|date/i)), interest: num(pick(r, /^interest$|shortinterest|short.?int/i)), dtc: num(pick(r, /days?.?to.?cover|cover/i)) });
  const sorted = rows.map(read).filter((r) => r.date && r.interest !== null).sort((a, b) => b.date!.localeCompare(a.date!));
  if (!sorted.length) return null;
  const [last, prev] = sorted;
  return {
    symbol, interest: last.interest, asOf: last.date, daysToCover: last.dtc,
    changePct: prev?.interest ? Math.round(((last.interest! / prev.interest - 1) * 100) * 10) / 10 : null,
    source: "Nasdaq",
  };
}

function findRows(x: unknown, depth = 0): Array<Record<string, unknown>> {
  if (!x || typeof x !== "object" || depth > 5) return [];
  if (Array.isArray(x)) return x.length && typeof x[0] === "object" && x[0] && Object.keys(x[0]).some((k) => /interest/i.test(k)) ? (x as Array<Record<string, unknown>>) : [];
  for (const v of Object.values(x)) {
    const r = findRows(v, depth + 1);
    if (r.length) return r;
  }
  return [];
}

/** Pure: squeeze risk from short interest (rules of thumb: a fifth of the shares short, or many days to cover). */
export function squeezeFrom(pct: number | null, dtc: number | null): ShortData["squeeze"] {
  if (pct === null && dtc === null) return null;
  const p = pct ?? 0, d = dtc ?? 0;
  return p >= 20 || d >= 8 ? "high" : p >= 10 || d >= 5 ? "elevated" : "normal";
}

/** Short interest for a few stocks (Nasdaq, one request each), with % of shares from Schwab when connected. */
export async function shortData(symbols: string[], fetchImpl?: typeof fetch): Promise<Map<string, ShortData>> {
  const out = new Map<string, ShortData>();
  const shares = new Map<string, number>();
  try {
    const { accessToken, fundamentals } = await import("../sources/schwab");
    if (await accessToken(fetchImpl)) for (const [s, f] of await fundamentals(symbols, fetchImpl)) if (f.sharesOutstanding) shares.set(s, f.sharesOutstanding);
  } catch {
    /* Schwab is optional */
  }
  for (const symbol of symbols) {
    try {
      const body = await getText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/short-interest?assetClass=stocks`, { headers: BROWSER, fetchImpl, cacheMs: 6 * 3600_000, minIntervalMs: 400, retries: 1, timeoutMs: 12_000 });
      const n = parseNasdaqShort(symbol, JSON.parse(body));
      if (!n) continue;
      const so = shares.get(symbol);
      const pct = n.interest !== null && so ? Math.round((n.interest / so) * 1000) / 10 : null;
      out.set(symbol, { ...n, pctOutstanding: pct, squeeze: squeezeFrom(pct, n.daysToCover), source: so ? "Nasdaq; shares outstanding from Schwab" : "Nasdaq" });
    } catch {
      /* no data for this one */
    }
  }
  return out;
}

/** Pure: one line for people and the research step. */
export function shortText(s: Pick<ShortData, "interest" | "asOf" | "changePct" | "daysToCover" | "pctOutstanding" | "squeeze"> | null | undefined): string | null {
  if (!s || s.interest === null) return null;
  const sh = s.interest >= 1e6 ? `${(s.interest / 1e6).toFixed(1)}M` : `${Math.round(s.interest / 1e3)}k`;
  const parts = [s.pctOutstanding !== null ? `${s.pctOutstanding}% of shares short (${sh})` : `${sh} shares short`];
  if (s.daysToCover !== null) parts.push(`${s.daysToCover} days to cover`);
  if (s.changePct !== null) parts.push(`${s.changePct > 0 ? "+" : ""}${s.changePct}% vs the prior report`);
  return `${parts.join(", ")}${s.asOf ? ` (settled ${s.asOf})` : ""}${s.squeeze ? `; squeeze risk ${s.squeeze}` : ""}`;
}
