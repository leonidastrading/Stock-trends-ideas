/**
 * Positioning: who is already in the trade.
 * 1. CFTC Commitments of Traders (publicreporting.cftc.gov, free): weekly futures positions as of Tuesday, out Friday
 *    3:30 PM ET. Speculators' net position (leveraged funds for financial futures, managed money for commodities)
 *    as a percentile of the last 3 years: at the extremes a trade is crowded.
 * 2. Dealer gamma, estimated from Cboe's free delayed option chains: the usual assumption that dealers are short the
 *    calls and long the puts customers hold. Above the gamma flip dealers damp moves; below it they amplify them.
 *    The call wall and put wall are the strikes with the most gamma. The dealer-side assumption is often wrong for
 *    single stocks; it is most reliable for index options (SPY, QQQ, IWM).
 * Context for the research, not signals on their own.
 */
import { getText } from "../http";
import { optionChain } from "../sources/cboe-options";
import { panel } from "./panels";

// ---------------------------------------------------------------- COT

/** The markets followed, with the ETFs and stocks that trade them (a card on one of these gets the market's positioning). */
export const COT_MARKETS = [
  { key: "es", name: "S&P 500 (e-mini)", code: "13874A", ds: "tff", etfs: ["SPY", "VOO", "IVV", "SPLG", "SPXL", "UPRO", "SH", "SDS", "SPXU"] },
  { key: "nq", name: "Nasdaq-100 (e-mini)", code: "209742", ds: "tff", etfs: ["QQQ", "QQQM", "TQQQ", "SQQQ", "PSQ"] },
  { key: "rty", name: "Russell 2000 (e-mini)", code: "239742", ds: "tff", etfs: ["IWM", "TNA", "TZA", "VTWO"] },
  { key: "vix", name: "VIX futures", code: "1170E1", ds: "tff", etfs: ["VXX", "UVXY", "VIXY", "SVXY"] },
  { key: "ty", name: "10-year Treasury note", code: "043602", ds: "tff", etfs: ["IEF", "TLT", "TLH", "TBT", "TMF", "ZROZ", "EDV"] },
  { key: "tu", name: "2-year Treasury note", code: "042601", ds: "tff", etfs: ["SHY", "SCHO", "VGSH"] },
  { key: "dx", name: "US dollar index", code: "098662", ds: "tff", etfs: ["UUP", "UDN"] },
  { key: "eur", name: "Euro", code: "099741", ds: "tff", etfs: ["FXE"] },
  { key: "jpy", name: "Japanese yen", code: "097741", ds: "tff", etfs: ["FXY"] },
  { key: "btc", name: "Bitcoin (CME)", code: "133741", ds: "tff", etfs: ["IBIT", "BITO", "FBTC", "GBTC", "ARKB", "MSTR"] },
  { key: "cl", name: "Crude oil (WTI)", code: "067651", ds: "dis", etfs: ["USO", "BNO", "XLE", "XOP", "OIH", "UCO", "SCO", "XOM", "CVX", "COP", "OXY"] },
  { key: "ng", name: "Natural gas", code: "023651", ds: "dis", etfs: ["UNG", "BOIL", "KOLD", "FCG", "EQT", "AR", "RRC"] },
  { key: "gc", name: "Gold", code: "088691", ds: "dis", etfs: ["GLD", "IAU", "GLDM", "GDX", "GDXJ", "NEM", "AEM", "GOLD"] },
  { key: "si", name: "Silver", code: "084691", ds: "dis", etfs: ["SLV", "SIL", "PAAS", "AG"] },
  { key: "hg", name: "Copper", code: "085692", ds: "dis", etfs: ["CPER", "COPX", "FCX", "SCCO"] },
  { key: "zc", name: "Corn", code: "002602", ds: "dis", etfs: ["CORN"] },
  { key: "zs", name: "Soybeans", code: "005602", ds: "dis", etfs: ["SOYB", "ADM", "BG"] },
  { key: "zw", name: "Wheat (Chicago)", code: "001602", ds: "dis", etfs: ["WEAT"] },
] as const;
export type CotMarket = (typeof COT_MARKETS)[number];

const DATASETS = { tff: "gpe5-46if", dis: "72hh-3qpy" } as const;
const CFTC = "https://publicreporting.cftc.gov/resource";

export interface CotReading {
  key: string; name: string; date: string; who: string;
  /** Speculators' net contracts, and as % of open interest. */
  net: number; netPctOi: number | null;
  /** Percentile of the net position over the last 3 years (0 = most short, 100 = most long). */
  index3y: number | null;
  change1w: number | null;
  crowd: "crowded long" | "crowded short" | null;
  weeks: number;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** A field by name pattern (the CFTC's column names vary slightly between reports). */
const field = (row: Record<string, unknown>, re: RegExp) => { const k = Object.keys(row).find((x) => re.test(x)); return k ? num(row[k]) : null; };

/** Pure: one market's rows (any order) → the latest reading. */
export function cotReading(m: Pick<CotMarket, "key" | "name" | "ds">, rows: Array<Record<string, unknown>>): CotReading | null {
  const longRe = m.ds === "tff" ? /^lev_money_positions_long$/ : /^m_money_positions_long_all$/;
  const shortRe = m.ds === "tff" ? /^lev_money_positions_short$/ : /^m_money_positions_short_all$/;
  const pts = rows.map((r) => {
    const l = field(r, longRe), s = field(r, shortRe), oi = field(r, /^open_interest_all$/);
    const date = String(r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    return l === null || s === null || !/^\d{4}-\d{2}-\d{2}$/.test(date) ? null : { date, net: l - s, oi };
  }).filter((x): x is { date: string; net: number; oi: number | null } => !!x).sort((a, b) => a.date.localeCompare(b.date)).slice(-156);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  const below = pts.filter((p) => p.net < last.net).length, equal = pts.filter((p) => p.net === last.net).length;
  const index3y = pts.length >= 26 ? Math.round(((below + 0.5 * equal) / pts.length) * 100) : null;
  return {
    key: m.key, name: m.name, date: last.date, who: m.ds === "tff" ? "leveraged funds" : "managed money",
    net: last.net, netPctOi: last.oi ? Math.round((last.net / last.oi) * 1000) / 10 : null, index3y,
    change1w: pts.length >= 2 ? last.net - pts[pts.length - 2].net : null,
    crowd: index3y === null ? null : index3y >= 90 ? "crowded long" : index3y <= 10 ? "crowded short" : null,
    weeks: pts.length,
  };
}

/** The latest COT reading for every followed market (one request per report type). */
export async function cotReadings(now = new Date(), fetchImpl?: typeof fetch): Promise<CotReading[]> {
  const since = new Date(now.getTime() - 3.2 * 365 * 86400_000).toISOString().slice(0, 10);
  const out: CotReading[] = [];
  for (const ds of ["tff", "dis"] as const) {
    const markets = COT_MARKETS.filter((m) => m.ds === ds);
    const where = `cftc_contract_market_code in(${markets.map((m) => `'${m.code}'`).join(",")}) AND report_date_as_yyyy_mm_dd >= '${since}'`;
    const url = `${CFTC}/${DATASETS[ds]}.json?${new URLSearchParams({ $where: where, $order: "report_date_as_yyyy_mm_dd DESC", $limit: "5000" })}`;
    const rows = JSON.parse(await getText(url, { headers: { accept: "application/json" }, fetchImpl, cacheMs: 6 * 3600_000, timeoutMs: 20_000 })) as Array<Record<string, unknown>>;
    for (const m of markets) {
      const r = cotReading(m, rows.filter((x) => String(x.cftc_contract_market_code ?? "").trim() === m.code));
      if (r) out.push(r);
    }
  }
  return out;
}

/** The COT market a stock or ETF trades with, if any. */
export const cotMarketFor = (symbol: string): CotMarket | undefined => COT_MARKETS.find((m) => (m.etfs as readonly string[]).includes(symbol.toUpperCase()));

// ---------------------------------------------------------------- dealer gamma

export interface GammaContract { type: "call" | "put"; strike: number; expiry: string; oi: number; iv: number | null; gamma: number | null }

/** Pure: Black-Scholes gamma (no dividends, rate r). */
export function bsGamma(spot: number, strike: number, years: number, iv: number, r = 0.04): number {
  if (!(spot > 0 && strike > 0 && years > 0 && iv > 0)) return 0;
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * years) / (iv * Math.sqrt(years));
  return Math.exp(-(d1 * d1) / 2) / Math.sqrt(2 * Math.PI) / (spot * iv * Math.sqrt(years));
}

export interface GammaProfile {
  symbol: string; spot: number; asOf: string;
  /** Dealers' net gamma, in $ of stock per 1% move (positive: they damp moves). */
  netGex: number;
  /** The price where dealers' net gamma turns from negative to positive; null if it does not cross within ±15%. */
  flip: number | null;
  callWall: number | null; putWall: number | null;
  regime: "damping" | "amplifying";
  contracts: number;
}

/** Pure: dealer gamma across a price range (each contract's gamma recomputed from its implied volatility at each price). */
export function gammaProfile(symbol: string, spot: number, asOf: string, contracts: GammaContract[], today: Date, maxDays = 90): GammaProfile | null {
  const live = contracts.map((c) => ({ ...c, years: (Date.parse(`${c.expiry}T21:00:00Z`) - today.getTime()) / (365 * 86400_000) }))
    .filter((c) => c.oi > 0 && c.years >= 1 / 365 && c.years <= maxDays / 365 && (c.iv ?? 0) > 0 && c.strike > spot * 0.5 && c.strike < spot * 1.5);
  if (live.length < 20) return null;
  const gexAt = (s: number) => live.reduce((sum, c) => sum + (c.type === "call" ? 1 : -1) * bsGamma(s, c.strike, c.years, c.iv!) * c.oi * 100 * s * s * 0.01, 0);
  const netGex = gexAt(spot);
  // The flip: scan ±15% in 0.5% steps for the price where net gamma crosses zero, nearest to spot.
  let flip: number | null = null;
  let prev: { s: number; g: number } | null = null;
  const crossings: number[] = [];
  for (let k = -30; k <= 30; k++) {
    const s = spot * (1 + k * 0.005), g = gexAt(s);
    if (prev && Math.sign(prev.g) !== Math.sign(g) && g !== 0) crossings.push(prev.s + ((0 - prev.g) / (g - prev.g)) * (s - prev.s));
    prev = { s, g };
  }
  if (crossings.length) flip = crossings.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
  // Walls: the strikes holding the most call gamma and put gamma at today's price.
  const byStrike = new Map<number, { call: number; put: number }>();
  for (const c of live) {
    const g = bsGamma(spot, c.strike, c.years, c.iv!) * c.oi * 100 * spot * spot * 0.01;
    const e = byStrike.get(c.strike) ?? { call: 0, put: 0 };
    if (c.type === "call") e.call += g; else e.put += g;
    byStrike.set(c.strike, e);
  }
  const top = (k: "call" | "put") => [...byStrike].sort((a, b) => b[1][k] - a[1][k])[0];
  const cw = top("call"), pw = top("put");
  return {
    symbol, spot, asOf, netGex: Math.round(netGex), flip: flip === null ? null : Math.round(flip * 100) / 100,
    callWall: cw && cw[1].call > 0 ? cw[0] : null, putWall: pw && pw[1].put > 0 ? pw[0] : null,
    regime: netGex >= 0 ? "damping" : "amplifying", contracts: live.length,
  };
}

/** Dealer gamma for one symbol from Cboe's delayed chain (cached 6 hours), or null. `cachedOnly`: never fetch a chain. */
export async function gammaFor(symbol: string, now = new Date(), fetchImpl?: typeof fetch, cachedOnly = false): Promise<GammaProfile | null> {
  if (cachedOnly) {
    const { cacheGet } = await import("../scout/store");
    const c = await cacheGet<GammaProfile | null>(`gamma:${symbol}`).catch(() => null);
    return c && now.getTime() - Date.parse(c.updatedAt) < 3 * 86400_000 ? c.data : null;
  }
  const p = await panel<GammaProfile | null>(`gamma:${symbol}`, 6 * 60, async () => {
    const chain = await optionChain(symbol, fetchImpl).catch(() => null);
    if (!chain) return null;
    return gammaProfile(symbol, chain.spot, chain.asOf, chain.contracts.map((c) => ({ type: c.type, strike: c.strike, expiry: c.expiry, oi: c.oi, iv: c.iv ?? null, gamma: c.gamma ?? null })), now);
  }, 25_000);
  return p.data ?? null;
}

// ---------------------------------------------------------------- words for people and the research step

const big = (n: number) => { const a = Math.abs(n); return `${n < 0 ? "−" : ""}$${a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(0)}M` : `${Math.round(a / 1e3)}k`}`; };

export function cotText(r: CotReading): string {
  return `${r.name}: ${r.who} net ${r.net >= 0 ? "long" : "short"} ${Math.abs(r.net).toLocaleString("en-US")} contracts${r.netPctOi !== null ? ` (${r.netPctOi}% of open interest)` : ""}, ${r.index3y !== null ? `${r.index3y}th percentile of 3 years` : "short history"}${r.change1w !== null ? `, ${r.change1w >= 0 ? "+" : ""}${r.change1w.toLocaleString("en-US")} on the week` : ""} (CFTC, as of ${r.date})${r.crowd ? ` — ${r.crowd.toUpperCase()}` : ""}`;
}

export function gammaText(g: GammaProfile): string {
  return `${g.symbol} dealer gamma (estimate, Cboe chains ${g.asOf}): net ${big(g.netGex)} per 1% move, ${g.regime === "damping" ? "positive: dealers damp moves" : "negative: dealers amplify moves"}; gamma flip ${g.flip !== null ? `$${g.flip}` : "not within ±15%"}; call wall $${g.callWall ?? "?"}, put wall $${g.putWall ?? "?"} (spot $${g.spot.toFixed(2)})`;
}

/** Positioning for a card's stock, as a block for the research step (null if there is nothing). */
export async function positioningFor(symbol: string, now = new Date(), fetchImpl?: typeof fetch, cachedOnly = false): Promise<{ text: string; cot: CotReading | null; gamma: GammaProfile | null } | null> {
  const m = cotMarketFor(symbol);
  const [cot, gamma] = await Promise.all([
    m ? panel<CotReading[]>("cot", 12 * 60, () => cotReadings(now, fetchImpl), 25_000).then((p) => p.data?.find((r) => r.key === m.key) ?? null).catch(() => null) : Promise.resolve(null),
    gammaFor(symbol, now, fetchImpl, cachedOnly).catch(() => null),
  ]);
  if (!cot && !gamma) return null;
  return { cot, gamma, text: [cot ? `Futures positioning: ${cotText(cot)}.` : "", gamma ? `Options: ${gammaText(gamma)}.` : ""].filter(Boolean).join(" ") };
}
