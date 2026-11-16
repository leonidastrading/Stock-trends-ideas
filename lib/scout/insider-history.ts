/**
 * What the insider-buy desk must check before calling a buy well timed:
 * - Each buyer's own track record at the company: their earlier Form 4 trades (buys and sales, two years), straight
 *   from the SEC (the scout's own table only goes back as far as it has been scanning), with the price paid against
 *   today's price. A buyer deep underwater on an earlier buy who buys again is averaging down, a weaker signal.
 * - Where the stock is in its range: 52-week high and low, and the 30- and 90-day moves, so "near the lows" is
 *   measured, not guessed.
 * All of it is data handed to the research step; nothing here decides.
 */
import type { DailyBar, MarketData } from "../alpaca";
import { getJson } from "../http";
import { fetchSec, SEC_ARCHIVE } from "../sources/filings";
import { addDays } from "../time";
import type { InsiderBuyRow } from "./store";

export interface Trade { date: string; side: "buy" | "sell"; shares: number; price: number; value: number; ownedAfter: number | null; plan10b5: boolean; accession: string }

const tag = (s: string, name: string) => (new RegExp(`<${name}>\\s*(?:<value>)?\\s*([^<]*)`, "i").exec(s)?.[1] ?? "").trim();

/** Pure: the open-market buys (P) and sales (S) in one Form 4, one line per trade. */
export function parseForm4Trades(text: string, accession: string): Trade[] {
  const xml = /<ownershipDocument>[\s\S]*<\/ownershipDocument>/i.exec(text)?.[0];
  if (!xml) return [];
  const plan = /true|1/i.test(tag(xml, "aff10b5One"));
  const out: Trade[] = [];
  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)) {
    const t = m[1];
    const code = tag(t, "transactionCode");
    if (code !== "P" && code !== "S") continue;
    const shares = Number(tag(t, "transactionShares")), price = Number(tag(t, "transactionPricePerShare"));
    if (!(shares > 0) || !(price > 0)) continue;
    const after = Number(tag(t, "sharesOwnedFollowingTransaction"));
    out.push({ date: tag(t, "transactionDate").slice(0, 10), side: code === "P" ? "buy" : "sell", shares, price, value: Math.round(shares * price), ownedAfter: after > 0 ? after : null, plan10b5: plan || /10b5-1/i.test(t), accession });
  }
  return out;
}

/** Pure: one insider's trades on the same day and side, added together (a Form 4 often splits one buy into lots). */
export function mergeTrades(trades: Trade[]): Trade[] {
  const by = new Map<string, Trade>();
  for (const t of trades) {
    const k = `${t.date}|${t.side}`;
    const x = by.get(k);
    if (!x) { by.set(k, { ...t }); continue; }
    const shares = x.shares + t.shares, value = x.value + t.value;
    by.set(k, { ...x, shares, value, price: Math.round((value / shares) * 100) / 100, ownedAfter: t.ownedAfter ?? x.ownedAfter, plan10b5: x.plan10b5 && t.plan10b5 });
  }
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x))}%`;

/** Pure: one buyer's record at the company before the current buying, against today's price. */
export function trackRecord(owner: string, earlier: Trade[], priceNow: number | null): string {
  if (!earlier.length) return `${owner}: no earlier open-market buys or sales at this company in the last two years (a first buy).`;
  const lines = earlier.slice(0, 8).map((t) => `${t.date} ${t.side === "buy" ? "bought" : "sold"} ${Math.round(t.shares).toLocaleString("en-US")} at $${t.price.toFixed(2)} (${usd(t.value)})${priceNow ? `, ${pct((priceNow / t.price - 1) * 100)} since` : ""}${t.plan10b5 ? ", 10b5-1 plan" : ""}`);
  const buys = earlier.filter((t) => t.side === "buy"), sells = earlier.filter((t) => t.side === "sell");
  const notes: string[] = [];
  if (buys.length && priceNow) {
    const cost = buys.reduce((a, t) => a + t.value, 0) / buys.reduce((a, t) => a + t.shares, 0);
    const r = (priceNow / cost - 1) * 100;
    notes.push(`earlier buys average $${cost.toFixed(2)}, ${pct(r)} at today's price${r <= -20 ? ": the new buying is averaging down on a losing position (a weaker signal than a fresh buy: cost-basis repair, defending the stake or a control agenda are other motives)" : r >= 20 ? ": earlier buys made money (a good record)" : ""}`);
  }
  if (sells.length && priceNow) {
    const avg = sells.reduce((a, t) => a + t.value, 0) / sells.reduce((a, t) => a + t.shares, 0);
    notes.push(`sold at an average $${avg.toFixed(2)}${avg > priceNow * 1.2 ? " (well above today: bought back lower, a sign of timing skill)" : ""}`);
  }
  return `${owner}, earlier trades at this company (two years, from the SEC):\n${lines.map((l) => `  · ${l}`).join("\n")}${notes.length ? `\n  → ${notes.join("; ")}` : ""}`;
}

/** Pure: where the stock is in its range. */
export function rangeLine(bars: DailyBar[]): string | null {
  const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (s.length < 20) return null;
  const now = s[s.length - 1].c;
  const hi = Math.max(...s.map((b) => b.h)), lo = Math.min(...s.map((b) => b.l));
  const back = (n: number) => s[Math.max(0, s.length - 1 - n)].c;
  const lowDate = s.find((b) => b.l === lo)?.date ?? "";
  return `Price ${s[s.length - 1].date}: $${now.toFixed(2)}. 52-week range $${lo.toFixed(2)} (${lowDate}) to $${hi.toFixed(2)}: ${pct((now / lo - 1) * 100)} above the low, ${pct((now / hi - 1) * 100)} from the high. Change: ${pct((now / back(21) - 1) * 100)} over 1 month, ${pct((now / back(63) - 1) * 100)} over 3 months, ${pct((now / back(126) - 1) * 100)} over 6 months. Only call a buy "near the lows" if these numbers say so.`;
}

type Submissions = { filings?: { recent?: { form: string[]; filingDate: string[]; accessionNumber: string[] } } };

async function form4s(cik: string, ua: string, fetchImpl?: typeof fetch): Promise<Array<{ acc: string; filed: string }>> {
  const j = await getJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 130, fetchImpl, retries: 1, cacheMs: 6 * 3600_000 });
  const r = j.filings?.recent;
  return r ? r.form.flatMap((f, i) => (f === "4" || f === "4/A" ? [{ acc: r.accessionNumber[i], filed: r.filingDate[i] }] : [])) : [];
}

/**
 * The context block for an insider signal: each buyer's earlier trades at the company (Form 4s filed by both the owner
 * and the issuer, two years, before the current buying) and the stock's range. Best effort: a part that fails is said.
 */
export async function insiderBackground(symbol: string, buys: InsiderBuyRow[], deps: { data: MarketData | null; ua: string | undefined; today: string; fetchImpl?: typeof fetch }, deadline = Infinity): Promise<string> {
  const parts: string[] = [];
  let priceNow: number | null = null;
  if (deps.data) {
    const bars = (await deps.data.getDailyBars([symbol], addDays(deps.today, -370), deps.today).catch(() => [] as DailyBar[])).filter((b) => b.symbol === symbol);
    const line = rangeLine(bars);
    if (line) parts.push(line);
    priceNow = bars.length ? bars.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1)!.c : null;
  }
  if (!deps.ua) return [...parts, "Earlier trades by these insiders: not checked (SEC_USER_AGENT not set)."].join("\n");
  const issuerCik = buys.find((b) => b.issuerCik)?.issuerCik;
  if (!issuerCik) return [...parts, "Earlier trades by these insiders: not checked (no issuer CIK)."].join("\n");
  try {
    const issuer = new Set((await form4s(issuerCik, deps.ua, deps.fetchImpl)).filter((f) => f.filed >= addDays(deps.today, -730)).map((f) => f.acc));
    const owners = new Map<string, InsiderBuyRow>();
    for (const b of buys) if (b.ownerCik && !owners.has(b.ownerCik)) owners.set(b.ownerCik, b);
    // The current buying: the earliest buy in the window; anything before it is the track record.
    const start = buys.map((b) => b.txDate ?? b.filed).sort()[0];
    for (const [ownerCik, b] of [...owners].slice(0, 4)) {
      if (Date.now() > deadline) { parts.push(`${b.owner}: earlier trades not checked (out of time).`); continue; }
      const accs = (await form4s(ownerCik, deps.ua, deps.fetchImpl)).filter((f) => issuer.has(f.acc)).slice(0, 15);
      const trades: Trade[] = [];
      for (const f of accs) {
        if (Date.now() > deadline) break;
        const text = await fetchSec(`${SEC_ARCHIVE}/edgar/data/${issuerCik}/${f.acc.replace(/-/g, "")}/${f.acc}.txt`, deps.ua, deps.fetchImpl).catch(() => "");
        trades.push(...parseForm4Trades(text, f.acc));
      }
      parts.push(trackRecord(b.owner ?? "insider", mergeTrades(trades.filter((t) => t.date < start)), priceNow));
    }
  } catch (err) {
    parts.push(`Earlier trades by these insiders: could not be read from the SEC (${err instanceof Error ? err.message.slice(0, 120) : String(err)}).`);
  }
  return parts.join("\n");
}
