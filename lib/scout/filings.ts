/**
 * The filings desk: insider buying, new activist stakes and bad-news 8-Ks,
 * read from the SEC's daily index (the day after filing; the drift these
 * signals are known for runs weeks to months, so a day's delay costs little).
 *
 * 1. Each call loads any daily index not read yet (last 5 business days) into
 *    a queue of Form 4, 8-K and Schedule 13D filings.
 * 2. Slices of the queue are read within a time budget: Form 4 XML for
 *    open-market purchases, the SEC header for 8-K items and 13D subjects.
 * 3. Once a day the strongest signals are researched as cards (at most 3):
 *    restatements and cyber incidents (bad news drifts), new 13Ds, and
 *    clustered or opportunistic insider buying.
 */
import type { Signal } from "../sources";
import { secTickerList } from "../sources/edgar";
import { fetchSec, headerUrl, indexUrl, isRoutine, parseForm4, parseFormIndex, parseHeader, SEC_ARCHIVE, seriousItems, SERIOUS_ITEMS, WANTED_FORMS } from "../sources/filings";
import { getJson } from "../http";
import { addDays, daysBetween, toEt } from "../time";
import { researchCandidate, type ResearchDeps } from "./research";
import * as congressHelpers from "./congress";
import { describeFlag } from "./options-flow";
import * as store from "./store";

export const FILINGS = { minBuyValue: 25_000, lookbackDays: 5, maxResearchPerDay: 4, clusterDays: 30 };

function businessDaysBefore(today: string, n: number): string[] {
  const out: string[] = [];
  for (let d = addDays(today, -1); out.length < n; d = addDays(d, -1)) if (![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) out.push(d);
  return out;
}

/** Load daily indexes not read yet into the queue. A missing index (holiday, or not published yet) is skipped. */
export async function loadIndexes(now: Date, ua: string, fetchImpl?: typeof fetch): Promise<{ loaded: string[]; queued: number }> {
  const days = businessDaysBefore(toEt(now).date, FILINGS.lookbackDays);
  const have = await store.secIndexLoaded(days);
  const out = { loaded: [] as string[], queued: 0 };
  for (const d of days.filter((x) => !have.has(x))) {
    let text: string;
    try {
      text = await fetchSec(indexUrl(d), ua, fetchImpl);
    } catch (err) {
      if (/ 40[34]\b/.test(err instanceof Error ? err.message : "")) continue;
      throw err;
    }
    const entries = parseFormIndex(text, WANTED_FORMS);
    await store.addSecIndex(d, entries);
    out.loaded.push(d);
    out.queued += entries.length;
  }
  return out;
}

/** Read queued filings until the deadline. */
export async function processQueue(deadline: number, ua: string, fetchImpl?: typeof fetch): Promise<{ read: number; buys: number; alerts: number; errors: number; pending: boolean }> {
  const out = { read: 0, buys: 0, alerts: 0, errors: 0, pending: false };
  let tickers: Map<string, string> | null = null;
  const tickerFor = async (cik: string) => {
    if (!tickers) tickers = new Map((await secTickerList(ua, fetchImpl).catch(() => [])).map((e) => [e.cik, e.ticker] as const).reverse());
    return tickers.get(cik.replace(/^0+/, "")) ?? null;
  };
  while (Date.now() < deadline) {
    const batch = await store.secQueue(100);
    if (!batch.length) return out;
    for (const f of batch) {
      if (Date.now() >= deadline) {
        out.pending = true;
        return out;
      }
      try {
        if (f.form === "4") {
          const b = parseForm4(await fetchSec(`${SEC_ARCHIVE}/${f.path}`, ua, fetchImpl));
          if (b && b.value >= FILINGS.minBuyValue && !b.plan10b5 && b.symbol) {
            const owner = b.ownerCik ? await getJson<{ filings?: { recent?: { form: string[]; filingDate: string[] } } }>(`https://data.sec.gov/submissions/CIK${b.ownerCik.padStart(10, "0")}.json`, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 130, fetchImpl, retries: 1 }).catch(() => null) : null;
            const r = owner?.filings?.recent;
            const dates = r ? r.filingDate.filter((_, i) => r.form[i] === "4") : [];
            await store.addInsiderBuy({ accession: f.accession, filed: f.filed, issuerCik: b.issuerCik, symbol: b.symbol, issuerName: b.issuerName, owner: b.owner, ownerCik: b.ownerCik, role: b.role, txDate: b.date || null, shares: b.shares, price: b.price, value: b.value, ownedAfter: b.ownedAfter, pctIncrease: b.pctIncrease, plan10b5: b.plan10b5, routine: isRoutine(dates, b.date || f.filed) });
            out.buys++;
          }
        } else {
          const h = parseHeader(await fetchSec(headerUrl(f), ua, fetchImpl));
          if (f.form === "8-K") {
            const s = seriousItems(h.items);
            if (s.length) {
              const cik = h.filer?.cik ?? f.cik;
              await store.addFilingAlert({ accession: f.accession, kind: "8-K", filed: f.filed, cik, symbol: await tickerFor(cik), company: h.filer?.name ?? f.company, items: s.map((x) => `${x.item} ${x.label}`), filer: null });
              out.alerts++;
            }
          } else if (h.subject) {
            await store.addFilingAlert({ accession: f.accession, kind: "13D", filed: f.filed, cik: h.subject.cik, symbol: await tickerFor(h.subject.cik), company: h.subject.name, items: [], filer: h.filedBy?.name ?? null });
            out.alerts++;
          }
        }
        await store.secDone(f.accession, "done");
        out.read++;
      } catch (err) {
        await store.secDone(f.accession, "error", err instanceof Error ? err.message.slice(0, 200) : String(err));
        out.errors++;
      }
    }
  }
  out.pending = true;
  return out;
}

// --------------------------------------------------------------- signals

export interface FilingSignal { kind: "8-K" | "13D" | "insider" | "options" | "congress" | "insider+congress"; symbol: string; term: string; strength: number; direction: "long" | "short"; context: string; trigger: Signal[] }

const CONGRESS_EVIDENCE = `What is known about following Congress: studies of 1990s trades found members' stock picks beat the market (Senate about 12 points a year, House about 6; Ziobrowski et al.), later work on 2004-2008 found their portfolios on average did not (Eggers & Hainmueller), and the clearest edge appears in trades tied to a member's committee or leadership role and in clusters. Reports can arrive up to 45 days after the trade, so much of any edge may be gone; judge the move since the filing, not since the trade. Ask: what would the members know (committee, home-state company, pending legislation or contracts), is there a dated catalyst, and has the stock already moved since the filing?`;

/** Pure: Congress clusters and stocks bought by both company insiders and members of Congress, each with something new in the last 5 days. */
export function smartMoneySignals(buys: store.InsiderBuyRow[], congress: store.CongressTradeRow[], today: string): FilingSignal[] {
  const out: FilingSignal[] = [];
  const recentIns = buys.filter((b) => b.symbol && daysBetween(b.filed, today) <= 45 && b.routine !== true && (b.value ?? 0) >= FILINGS.minBuyValue);
  const recentCon = congress.filter((t) => daysBetween(t.filed, today) <= 45 && t.tx === "buy" && t.assetType === "stock");
  const fresh = (d: string) => daysBetween(d, today) <= 5;
  const line = (t: store.CongressTradeRow) => `${t.member} (${t.chamber}) bought ${t.symbol} ${t.amount} on ${t.txDate}, reported ${t.filed}`;
  const both = new Set<string>();
  for (const sym of new Set(recentCon.map((t) => t.symbol))) {
    const ins = recentIns.filter((b) => b.symbol === sym);
    const con = recentCon.filter((t) => t.symbol === sym);
    if (!ins.length || ![...ins.map((b) => b.filed), ...con.map((t) => t.filed)].some(fresh)) continue;
    both.add(sym);
    const insLines = ins.slice(0, 5).map((b) => `${b.owner} (${b.role}) bought ${usd(b.value ?? 0)} on ${b.txDate ?? b.filed}${b.pctIncrease !== null ? `, +${b.pctIncrease}% to their holding` : ""}${b.routine === false ? ", outside their usual trading month" : ""}`);
    out.push({
      kind: "insider+congress", symbol: sym, term: `insider+congress: ${sym}`, strength: 3.5, direction: "long",
      context: `Both company insiders and members of Congress bought ${sym} within the last 45 days.\nInsiders (SEC Form 4, open-market purchases, not 10b5-1 plans):\n${insLines.map((l) => `- ${l}`).join("\n")}\nCongress (STOCK Act reports):\n${con.slice(0, 6).map((t) => `- ${line(t)}`).join("\n")}\nInsider purchases that are not routine have earned roughly 0.8% a month for about six months (Cohen, Malloy & Pomorski). ${CONGRESS_EVIDENCE} Two independent groups with an information edge buying the same stock is rarer and stronger than either alone, but check that they are not reacting to the same public news.`,
      trigger: [{ source: "edgar+congress", metric: `insider_and_congress_buys:${sym}`, value: ins.length + con.length, baseline: null, changeVs12m: null, asOf: [...ins.map((b) => b.filed), ...con.map((t) => t.filed)].sort().at(-1)!, note: `${new Set(ins.map((b) => b.owner)).size} insider(s) and ${new Set(con.map((t) => t.member)).size} member(s) of Congress bought ${sym} in 45 days` }],
    });
  }
  // Clusters in Congress alone: three or more members buying (or two with $100k+) in 30 days, fewer selling.
  const { bySymbol } = congressHelpers;
  for (const a of bySymbol(congress, addDays(today, -30)).filter((x) => x.cluster && fresh(x.lastFiled) && !both.has(x.symbol))) {
    const con = recentCon.filter((t) => t.symbol === a.symbol && daysBetween(t.filed, today) <= 30);
    out.push({
      kind: "congress", symbol: a.symbol, term: `congress: ${a.symbol}`, strength: a.buyers.length >= 3 ? 2.5 : 2, direction: "long",
      context: `${a.buyers.length} members of Congress bought ${a.symbol} in reports filed over the last 30 days (about ${usd(a.buyUsd)} at range midpoints)${a.sellers.length ? `; ${a.sellers.length} sold (${a.sellers.join(", ")})` : ""}:\n${con.slice(0, 8).map((t) => `- ${line(t)}`).join("\n")}\n${CONGRESS_EVIDENCE}`,
      trigger: [{ source: "congress", metric: `congress_buyers_30d:${a.symbol}`, value: a.buyers.length, baseline: null, changeVs12m: null, asOf: a.lastFiled, note: `${a.buyers.length} members of Congress bought ${a.symbol} in 30 days (${a.buyers.join(", ")})` }],
    });
  }
  return out;
}

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

/** Pure: the day's candidate signals from stored buys and alerts, strongest first. */
export function pickSignals(buys: store.InsiderBuyRow[], alerts: store.FilingAlert[], today: string, flags: store.OptionsFlag[] = [], congress: store.CongressTradeRow[] = []): FilingSignal[] {
  const out: FilingSignal[] = smartMoneySignals(buys, congress, today);
  // Unusual new options positions (last two days): the largest per stock and side.
  const best = new Map<string, store.OptionsFlag>();
  for (const f of flags.filter((x) => daysBetween(x.date, today) <= 2)) {
    const k = `${f.symbol}:${f.type}`;
    if ((f.premiumUsd ?? 0) > (best.get(k)?.premiumUsd ?? -1)) best.set(k, f);
  }
  for (const f of best.values()) {
    const same = flags.filter((x) => x.symbol === f.symbol && x.type === f.type && daysBetween(x.date, today) <= 2);
    out.push({
      kind: "options", symbol: f.symbol, term: `options: ${f.symbol} ${f.type}s ${f.expiry}`, strength: (f.premiumUsd ?? 0) >= 25_000_000 || (f.multiple ?? 0) >= 20 ? 2.5 : 1.5, direction: f.type === "put" ? "short" : "long",
      context: `Unusual new options positions in ${f.symbol} (Cboe open interest, ${f.date}, vs the previous trading day):\n${same.map((x) => `- ${describeFlag(x)}`).join("\n")}\nWhat open interest shows and does not: a contract's open interest rises by the same amount whether the new position was bought or sold to open, so the side is unknown; most large out-of-the-money put positions are hedges, collars or fund rolls, and large call positions are often overwriting. The evidence that option positioning carries information: newly opened, buyer-initiated put and call volume predicts the stock's next-week returns (Pan & Poteshman 2006), and abnormal out-of-the-money volume builds before takeover announcements (Augustin, Brenner & Subrahmanyam 2019). Find a reason: a dated catalyst before ${f.expiry}, news, a known holder who would hedge, or the company's own situation. A ratio spread (more contracts sold further out) is a bet on a measured move to the far strike, not a collapse. If there is no plausible information story, say so and do not promote. Proposed direction follows the side most consistent with the structure (${f.type === "put" ? "puts: short" : "calls: long"}), stated with low confidence.`,
      trigger: [{ source: "cboe", metric: `oi_build:${f.symbol}:${f.type}`, value: f.oi - f.prevOi, baseline: f.baseline, changeVs12m: null, asOf: f.date, note: describeFlag(f) }],
    });
  }
  for (const a of alerts.filter((x) => x.symbol && daysBetween(x.filed, today) <= 5)) {
    if (a.kind === "8-K") {
      const research = SERIOUS_ITEMS.filter((s) => s.research && a.items.some((i) => i.startsWith(s.item)));
      if (!research.length) continue;
      out.push({
        kind: "8-K", symbol: a.symbol!, term: `filing: ${a.symbol} 8-K ${research.map((r) => r.item).join("+")}`, strength: 3, direction: "short",
        context: `SEC filing (8-K, filed ${a.filed}) by ${a.company}: ${a.items.join("; ")}. The news playbook: non-reliance (item 4.02) and material cybersecurity incidents (item 1.05) are among the clearest "follow the bad news" setups; bad news drifts for weeks to months, and the first cyber filing is usually incomplete. Check the company's size, the scope disclosed, and whether the move so far has priced it. Expected direction short unless the measurements say the market has already overreacted.`,
        trigger: [{ source: "edgar", metric: `8k_items:${a.symbol}`, value: research.length, baseline: null, changeVs12m: null, asOf: a.filed, note: `${a.company} 8-K filed ${a.filed}: ${a.items.join("; ")}` }],
      });
    } else {
      out.push({
        kind: "13D", symbol: a.symbol!, term: `filing: ${a.symbol} 13D ${a.filer ?? ""}`.trim(), strength: 2, direction: "long",
        context: `New Schedule 13D (activist or control stake) in ${a.company}, filed ${a.filed} by ${a.filer ?? "an investor"}. The evidence: 13D targets earn abnormal returns over the following weeks with no reversal over the year (Brav, Jiang, Partnoy & Thomas), though the announcement effect has shrunk as activism got crowded; hostile tactics and "sale of the company" agendas move prices most. Since 2024 13Ds are due within 5 business days, so more of the move prints at the filing. Say who the filer is, what they want, and whether the stake is passive in practice.`,
        trigger: [{ source: "edgar", metric: `new_13d:${a.symbol}`, value: 1, baseline: null, changeVs12m: null, asOf: a.filed, note: `New 13D in ${a.company} by ${a.filer ?? "?"} filed ${a.filed}` }],
      });
    }
  }
  // Insider buying: by issuer over the last 30 days; opportunistic (not routine), clustered or large against holdings.
  const recent = buys.filter((b) => b.symbol && daysBetween(b.filed, today) <= FILINGS.clusterDays && b.routine !== true);
  const bySym = new Map<string, store.InsiderBuyRow[]>();
  for (const b of recent) bySym.set(b.symbol!, [...(bySym.get(b.symbol!) ?? []), b]);
  for (const [symbol, bs] of bySym) {
    if (!bs.some((b) => daysBetween(b.filed, today) <= 5)) continue; // something new this week
    const owners = new Set(bs.map((b) => b.owner));
    const total = bs.reduce((a, b) => a + (b.value ?? 0), 0);
    const big = bs.some((b) => (b.value ?? 0) >= 100_000 && (b.pctIncrease ?? 0) >= 10);
    if (owners.size < 2 && !big) continue;
    const lines = bs.slice(0, 6).map((b) => `${b.owner} (${b.role}) bought ${Math.round(b.shares ?? 0).toLocaleString("en-US")} shares at $${b.price} = ${usd(b.value ?? 0)} on ${b.txDate ?? b.filed}${b.pctIncrease !== null ? `, +${b.pctIncrease}% to their holding` : ""}${b.routine === false ? ", outside their usual trading month (opportunistic)" : ""}`);
    out.push({
      kind: "insider", symbol, term: `insider: ${symbol}`, strength: owners.size >= 3 ? 2.5 : owners.size >= 2 ? 2 : 1, direction: "long",
      context: `Insider open-market purchases (Form 4, code P, not under a 10b5-1 plan) in ${bs[0].issuerName} over the last ${FILINGS.clusterDays} days: ${owners.size} insider(s), ${usd(total)} in total.\n${lines.map((l) => `- ${l}`).join("\n")}\nThe evidence: opportunistic insider purchases (not the insider's routine calendar month) earned about 0.8% a month for about six months with no reversal (Cohen, Malloy & Pomorski); markets underreact to them. Strongest when several insiders buy, after a decline, in small and mid caps, and when the purchase is large against the insider's holding. Routine purchases earn about nothing. Horizon about six months.`,
      trigger: [{ source: "edgar", metric: `insider_buys_30d:${symbol}`, value: owners.size, baseline: null, changeVs12m: null, asOf: bs[0].filed, note: `${owners.size} insider(s) bought ${usd(total)} of ${symbol} in 30 days` }],
    });
  }
  return out.sort((a, b) => b.strength - a.strength);
}

/** Once a day: research the strongest new filing signals (at most 3), each once per 30 days. */
export async function runFilingResearch(deps: ResearchDeps, maxNow: number = FILINGS.maxResearchPerDay): Promise<{ signals: number; researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>; error: string | null }> {
  const today = toEt(deps.now).date;
  const settings = await store.loadSettings();
  if (!settings.enabled) return { signals: 0, researched: [], error: "scout is switched off in Settings" };
  const [buys, alerts, flags, congress, recent, lastDay] = await Promise.all([store.insiderBuysSince(addDays(today, -50)), store.filingAlertsSince(addDays(today, -10)), store.optionsFlagsSince(addDays(today, -3)), store.congressTradesSince(addDays(today, -45)), store.recentTerms(30), store.recentTerms(1)]);
  const doneToday = [...lastDay].filter((t) => /^(filing|insider|options|congress|insider\+congress): /.test(t)).length;
  const room = Math.max(0, Math.min(maxNow, FILINGS.maxResearchPerDay - doneToday));
  const signals = pickSignals(buys, alerts, today, flags, congress).filter((s) => ![...recent].some((t) => t.startsWith(s.term.toLowerCase().split(" ").slice(0, 2).join(" "))));
  const out = { signals: signals.length, researched: [] as Array<{ term: string; outcome: string; reason?: string; cardId?: number }>, error: null as string | null };
  for (const s of signals.slice(0, room)) {
    const r = await researchCandidate({ origin: "scout", term: s.term, kindHint: "event", tickersHint: [s.symbol], observation: null, trigger: s.trigger, context: `${s.context}\nProposed direction: ${s.direction} ${s.symbol}.` }, deps);
    out.researched.push(r.outcome === "card" ? { term: s.term, outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term: s.term, outcome: r.outcome, reason: r.reason });
    if (r.outcome === "capped") {
      out.error = r.reason;
      break;
    }
  }
  return out;
}
