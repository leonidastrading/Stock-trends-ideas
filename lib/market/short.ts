/**
 * Short interest (exchanges publish it twice a month). FINRA's consolidated short-interest data first (every
 * exchange-listed and OTC stock), Nasdaq's per-stock page as a fallback (it may cover Nasdaq-listed stocks only).
 * Schwab, when connected, adds the float and shares outstanding for "% of float short". Schwab's own short-interest
 * fields come back as zero, so they are not used.
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
  /** % of the float and of shares outstanding sold short (need Schwab's share counts). */
  pctFloat?: number | null;
  pctOutstanding: number | null;
  squeeze: "high" | "elevated" | "normal" | null;
  source: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || /^n\/?a$/i.test(t)) return null;
  const n = Number(t.replace(/[,$%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const isoDate = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

type Base = Omit<ShortData, "pctOutstanding" | "pctFloat" | "squeeze">;

const latest = (symbol: string, rows: Array<{ date: string | null; interest: number | null; dtc: number | null; prev?: number | null }>, source: string): Base | null => {
  const sorted = rows.filter((r) => r.date && r.interest !== null).sort((a, b) => b.date!.localeCompare(a.date!));
  if (!sorted.length) return null;
  const [last, before] = sorted;
  const prev = last.prev ?? before?.interest ?? null;
  return { symbol, interest: last.interest, asOf: last.date, daysToCover: last.dtc, changePct: prev ? Math.round(((last.interest! / prev - 1) * 100) * 10) / 10 : null, source };
};

/** Pure: Nasdaq's short-interest reply → the latest report and the change since the one before (field names matched loosely). */
export function parseNasdaqShort(symbol: string, json: unknown): Base | null {
  const rows = findRows(json);
  const pick = (r: Record<string, unknown>, re: RegExp) => Object.entries(r).find(([k]) => re.test(k))?.[1];
  return latest(symbol, rows.map((r) => ({ date: isoDate(pick(r, /settlement|date/i)), interest: num(pick(r, /^interest$|shortinterest|short.?int/i)), dtc: num(pick(r, /days?.?to.?cover|cover/i)) })), "Nasdaq");
}

/** Pure: FINRA's consolidated short-interest records → the latest report. */
export function parseFinraShort(symbol: string, json: unknown): Base | null {
  const rows = Array.isArray(json) ? (json as Array<Record<string, unknown>>) : findRows(json, /short|settlement/i);
  const mine = rows.filter((r) => !r.symbolCode || String(r.symbolCode).toUpperCase() === symbol);
  return latest(symbol, mine.map((r) => ({ date: isoDate(r.settlementDate), interest: num(r.currentShortPositionQuantity ?? r.currentShortShareNumber), dtc: num(r.daysToCoverQuantity), prev: num(r.previousShortPositionQuantity) })), "FINRA");
}

function findRows(x: unknown, keyRe = /interest/i, depth = 0): Array<Record<string, unknown>> {
  if (!x || typeof x !== "object" || depth > 5) return [];
  if (Array.isArray(x)) return x.length && typeof x[0] === "object" && x[0] && Object.keys(x[0]).some((k) => keyRe.test(k)) ? (x as Array<Record<string, unknown>>) : [];
  for (const v of Object.values(x)) {
    const r = findRows(v, keyRe, depth + 1);
    if (r.length) return r;
  }
  return [];
}

/** Pure: squeeze risk from short interest (rules of thumb: a fifth of the float short, or many days to cover). */
export function squeezeFrom(pct: number | null, dtc: number | null): ShortData["squeeze"] {
  if (pct === null && dtc === null) return null;
  const p = pct ?? 0, d = dtc ?? 0;
  return p >= 20 || d >= 8 ? "high" : p >= 10 || d >= 5 ? "elevated" : "normal";
}

async function finra(symbol: string, fetchImpl?: typeof fetch): Promise<Base | null> {
  const f = fetchImpl ?? fetch;
  const res = await f("https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": BROWSER["user-agent"] },
    // No sortFields (FINRA refuses them on this dataset): ask for the last 60 days and sort here.
    body: JSON.stringify({
      limit: 20,
      compareFilters: [{ compareType: "equal", fieldName: "symbolCode", fieldValue: symbol }],
      dateRangeFilters: [{ fieldName: "settlementDate", startDate: new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10) }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FINRA ${res.status}: ${(() => { try { return String(JSON.parse(text).message ?? text); } catch { return text; } })().replace(/\s+/g, " ").slice(0, 300)}`);
  return parseFinraShort(symbol, text.trim() ? JSON.parse(text) : []);
}

async function nasdaq(symbol: string, fetchImpl?: typeof fetch): Promise<Base | null> {
  const body = await getText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/short-interest?assetClass=stocks`, { headers: BROWSER, fetchImpl, cacheMs: 6 * 3600_000, minIntervalMs: 400, retries: 1, timeoutMs: 12_000 });
  return parseNasdaqShort(symbol, JSON.parse(body));
}

/** Short interest for a few stocks (FINRA, else Nasdaq), with % of float and of shares from Schwab when connected. Errors per stock in `errors`. */
export async function shortData(symbols: string[], fetchImpl?: typeof fetch): Promise<Map<string, ShortData> & { errors?: Map<string, string> }> {
  const out = new Map<string, ShortData>() as Map<string, ShortData> & { errors?: Map<string, string> };
  out.errors = new Map();
  const shares = new Map<string, { out: number | null; float: number | null }>();
  try {
    const { accessToken, fundamentals } = await import("../sources/schwab");
    if (await accessToken(fetchImpl)) for (const [s, f] of await fundamentals(symbols, fetchImpl)) shares.set(s, { out: f.sharesOutstanding, float: f.floatShares });
  } catch {
    /* Schwab is optional */
  }
  for (const symbol of symbols) {
    const errs: string[] = [];
    let base: Base | null = null;
    for (const [name, get] of [["FINRA", finra], ["Nasdaq", nasdaq]] as const) {
      try {
        base = await get(symbol, fetchImpl);
        if (base) break;
        errs.push(`${name}: no report`);
      } catch (err) {
        errs.push(`${name}: ${err instanceof Error ? err.message.slice(0, 320) : String(err)}`);
      }
    }
    if (!base) { out.errors.set(symbol, errs.join("; ")); continue; }
    const sh = shares.get(symbol);
    const pct = (d: number | null | undefined) => (base!.interest !== null && d ? Math.round((base!.interest / d) * 1000) / 10 : null);
    const pctFloat = pct(sh?.float), pctOutstanding = pct(sh?.out);
    out.set(symbol, { ...base, pctFloat, pctOutstanding, squeeze: squeezeFrom(pctFloat ?? pctOutstanding, base.daysToCover), source: sh?.float || sh?.out ? `${base.source}; float from Schwab` : base.source });
  }
  return out;
}

/** Pure: one line for people and the research step. */
export function shortText(s: Pick<ShortData, "interest" | "asOf" | "changePct" | "daysToCover" | "pctOutstanding" | "squeeze"> & { pctFloat?: number | null } | null | undefined): string | null {
  if (!s || s.interest === null) return null;
  const sh = s.interest >= 1e6 ? `${(s.interest / 1e6).toFixed(1)}M` : `${Math.round(s.interest / 1e3)}k`;
  const parts = [s.pctFloat != null ? `${s.pctFloat}% of float short (${sh} shares)` : s.pctOutstanding !== null ? `${s.pctOutstanding}% of shares short (${sh})` : `${sh} shares short`];
  if (s.daysToCover !== null) parts.push(`${s.daysToCover} days to cover`);
  if (s.changePct !== null) parts.push(`${s.changePct > 0 ? "+" : ""}${s.changePct}% vs the prior report`);
  return `${parts.join(", ")}${s.asOf ? ` (settled ${s.asOf})` : ""}${s.squeeze ? `; squeeze risk ${s.squeeze}` : ""}`;
}
