/**
 * Free public sources for the dashboard panels (each checked from Vercel's
 * network on 2026-11-14):
 * - Treasury yields: home.treasury.gov daily par yield curve CSV.
 * - VIX: Cboe's delayed quote JSON and its daily history CSV.
 * - Earnings calendar: Nasdaq's calendar API (date, EPS forecast, market cap).
 * - Federal contracts: USAspending.gov transactions (new obligations), with
 *   recipients matched to listed companies.
 * Index futures need a paid feed, so the market row uses the ETFs (SPY, QQQ,
 * IWM, USO) from Alpaca against their previous close.
 */
import { getText } from "../http";

const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "application/json, text/plain, */*" };

// ------------------------------------------------------------- Treasury

export interface Yields { date: string; y10: number; y30: number; prev10: number | null; prev30: number | null }

/** Pure: the newest two rows of the Treasury daily par yield curve CSV. */
export function parseTreasuryCsv(csv: string): Yields | null {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const i10 = head.indexOf("10 Yr"), i30 = head.indexOf("30 Yr");
  if (i10 < 0 || i30 < 0) return null;
  const rows = lines.slice(1).map((l) => l.split(",")).filter((c) => c[i10] && c[i30]);
  if (!rows.length) return null;
  const iso = (d: string) => { const [m, dd, y] = d.split("/"); return `${y}-${m}-${dd}`; };
  const sorted = rows.sort((a, b) => iso(b[0]).localeCompare(iso(a[0])));
  return { date: iso(sorted[0][0]), y10: Number(sorted[0][i10]), y30: Number(sorted[0][i30]), prev10: sorted[1] ? Number(sorted[1][i10]) : null, prev30: sorted[1] ? Number(sorted[1][i30]) : null };
}

export async function treasuryYields(year: number, fetchImpl?: typeof fetch): Promise<Yields | null> {
  const csv = await getText(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`, { headers: BROWSER, fetchImpl, cacheMs: 30 * 60000 });
  return parseTreasuryCsv(csv);
}

// ------------------------------------------------------------------ VIX

export interface Vix { last: number; changePct: number | null; avg1y: number | null }

export async function vix(fetchImpl?: typeof fetch): Promise<Vix | null> {
  const q = JSON.parse(await getText("https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json", { headers: BROWSER, fetchImpl, cacheMs: 10 * 60000 })) as { data?: { current_price?: number; price_change_percent?: number } };
  if (!q.data?.current_price) return null;
  let avg1y: number | null = null;
  try {
    const hist = await getText("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv", { headers: BROWSER, fetchImpl, cacheMs: 6 * 60 * 60000 });
    const closes = hist.trim().split(/\r?\n/).slice(-252).map((l) => Number(l.split(",")[4])).filter((x) => x > 0);
    if (closes.length > 100) avg1y = closes.reduce((a, b) => a + b, 0) / closes.length;
  } catch {
    /* the average is optional */
  }
  return { last: q.data.current_price, changePct: q.data.price_change_percent ?? null, avg1y };
}

// ------------------------------------------------------------- earnings

export interface EarningsRow { date: string; symbol: string; name: string; marketCap: number | null; eps: string | null; time: string }

/** Pure: one day of Nasdaq's earnings calendar. */
export function parseNasdaqEarnings(json: unknown, date: string): EarningsRow[] {
  const rows = (json as { data?: { rows?: Array<Record<string, string>> | null } })?.data?.rows ?? [];
  return rows.map((r) => ({
    date, symbol: (r.symbol ?? "").trim().toUpperCase(), name: r.name ?? "",
    marketCap: Number((r.marketCap ?? "").replace(/[$,]/g, "")) || null,
    eps: r.epsForecast && r.epsForecast !== "" ? r.epsForecast : null,
    time: (r.time ?? "").replace(/^time-/, "").replace("not-supplied", "time not given").replace("after-hours", "after close").replace("pre-market", "before open"),
  })).filter((r) => /^[A-Z][A-Z.]{0,5}$/.test(r.symbol));
}

export async function earningsOn(date: string, fetchImpl?: typeof fetch): Promise<EarningsRow[]> {
  const j = JSON.parse(await getText(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: BROWSER, fetchImpl, cacheMs: 60 * 60000, minIntervalMs: 400 }));
  return parseNasdaqEarnings(j, date);
}

// ------------------------------------------------------------- contracts

export interface ContractTx { date: string; recipient: string; amount: number; agency: string; description: string; awardId: string }

export async function recentContracts(from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<ContractTx[]> {
  const res = await fetchImpl("https://api.usaspending.gov/api/v2/search/spending_by_transaction/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ filters: { award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: from, end_date: to }] }, fields: ["Award ID", "Recipient Name", "Action Date", "Transaction Amount", "Awarding Agency", "Transaction Description"], sort: "Transaction Amount", order: "desc", limit: 100, page: 1 }),
  });
  if (!res.ok) throw new Error(`USAspending ${res.status}`);
  const j = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (j.results ?? []).map((r) => ({ date: String(r["Action Date"] ?? ""), recipient: String(r["Recipient Name"] ?? ""), amount: Number(r["Transaction Amount"] ?? 0), agency: String(r["Awarding Agency"] ?? ""), description: String(r["Transaction Description"] ?? ""), awardId: String(r["Award ID"] ?? "") }));
}

/** Big federal contractors whose award names do not match their listed parent's name. */
const CONTRACTOR_ALIASES: Array<[RegExp, string]> = [
  [/\bRAYTHEON\b|PRATT ?& ?WHITNEY|COLLINS AEROSPACE/, "RTX"], [/\bLOCKHEED\b|SIKORSKY/, "LMT"], [/NORTHROP GRUMMAN/, "NOC"],
  [/GENERAL DYNAMICS|ELECTRIC BOAT|BATH IRON WORKS|GULFSTREAM/, "GD"], [/\bBOEING\b/, "BA"], [/\bL3 ?HARRIS\b|HARRIS CORP/, "LHX"],
  [/HUNTINGTON INGALLS|NEWPORT NEWS SHIPBUILDING/, "HII"], [/\bLEIDOS\b/, "LDOS"], [/BOOZ ALLEN/, "BAH"], [/SCIENCE APPLICATIONS INTERNATIONAL|\bSAIC\b/, "SAIC"],
  [/\bCACI\b/, "CACI"], [/ACCENTURE/, "ACN"], [/\bIBM\b|INTERNATIONAL BUSINESS MACHINES/, "IBM"], [/AMAZON WEB SERVICES|\bAMAZON\b/, "AMZN"], [/MICROSOFT/, "MSFT"],
  [/\bORACLE\b/, "ORCL"], [/PALANTIR/, "PLTR"], [/\bPARSONS\b/, "PSN"], [/\bKBR\b|KELLOGG BROWN/, "KBR"], [/\bJACOBS\b/, "J"], [/\bFLUOR\b/, "FLR"], [/\bAECOM\b/, "ACM"],
  [/HONEYWELL/, "HON"], [/MCKESSON/, "MCK"], [/CARDINAL HEALTH/, "CAH"], [/\bHUMANA\b/, "HUM"], [/HEALTH NET|CENTENE/, "CNC"], [/OPTUM|UNITEDHEALTH|UNITED HEALTHCARE/, "UNH"],
  [/\bMAXIMUS\b/, "MMS"], [/MOTOROLA SOLUTIONS/, "MSI"], [/\bTEXTRON\b|BELL TEXTRON/, "TXT"], [/OSHKOSH/, "OSK"], [/\bKRATOS\b/, "KTOS"], [/MERCURY SYSTEMS/, "MRCY"],
  [/\bV2X\b|VECTRUS/, "VVX"], [/\bAMENTUM\b/, "AMTM"], [/\bCGI FEDERAL\b/, "GIB"], [/VERIZON/, "VZ"], [/\bAT&T\b|AT ?& ?T CORP/, "T"], [/\bDELL\b/, "DELL"], [/HEWLETT PACKARD ENTERPRISE/, "HPE"],
  [/\bCISCO\b/, "CSCO"], [/\bPFIZER\b/, "PFE"], [/MODERNA/, "MRNA"], [/GENERAL ELECTRIC|GE AEROSPACE/, "GE"], [/BWX ?T/, "BWXT"], [/\bCURTISS.WRIGHT\b/, "CW"], [/TELEDYNE/, "TDY"],
  [/\bANDURIL\b/, ""], [/\bSPACE EXPLORATION TECHNOLOGIES\b|\bSPACEX\b/, ""], [/BECHTEL/, ""], [/BLUE ORIGIN/, ""],
];

const GENERIC = new Set("general american national united international advanced applied global first new north south east west pacific atlantic central southern northern western eastern standard digital energy health science sciences data systems technology technologies services solutions group holdings capital financial bank trust power security defense medical industries federal government management consulting engineering construction associates partners enterprises".split(" "));
const STOP = new Set("inc incorporated corp corporation co company ltd limited llc lp plc the and of llp pllc".split(" "));
const tokens = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));

/** Pure: the listed company behind a contract recipient, or null (private, foreign, or no confident match). */
export function contractorTicker(recipient: string, sec: Array<{ ticker: string; title: string }>): string | null {
  const up = recipient.toUpperCase();
  for (const [re, t] of CONTRACTOR_ALIASES) if (re.test(up)) return t || null;
  const r = tokens(recipient);
  if (!r.length) return null;
  let best: { ticker: string; score: number } | null = null;
  for (const e of sec) {
    const t = tokens(e.title);
    if (!t.length || t[0] !== r[0]) continue;
    let n = 0;
    while (n < Math.min(t.length, r.length) && t[n] === r[n]) n++;
    const ok = n >= 2 || (t.length === 1 && t[0].length >= 4 && !GENERIC.has(t[0]));
    if (ok && (!best || n > best.score)) best = { ticker: e.ticker, score: n };
  }
  return best?.ticker ?? null;
}
