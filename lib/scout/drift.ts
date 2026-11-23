/**
 * The down-drift desk: stocks that fell on clearly negative news and kept falling over the following days.
 *
 * Why: bad public news is followed by drift that lasts months, while big moves without news tend to reverse
 * (Chan 2003); bad news travels slowly where analyst coverage is thin (Hong, Lim & Stein 2000); negative wording
 * predicts weak earnings and returns the market is slow to price (Tetlock, Saar-Tsechansky & Macskassy 2008;
 * Lopez-Lira & Tang find headline sentiment predicts returns most for negative news and small caps); holders
 * sitting on gains sell bad news slowly (Frazzini 2006).
 *
 * Detection (hourly, cached): a universe of large and mid caps plus each day's biggest losers, stocks with
 * negative headlines and stocks with bad-news 8-Ks; the largest one-day drop against SPY in the last two weeks,
 * which must line up with a negative event headline or 8-K; then at least two more trading days lower with no
 * real bounce. Research: the freshest setups, at most two a day, as short ideas held about 20 trading days.
 */
import { CHATTER_UNIVERSE } from "@/config/chatter";
import { UNIVERSE } from "@/config/universe";
import type { DailyBar, MarketData, NewsItem } from "../alpaca";
import type { Signal } from "../sources";
import { addDays, toEt } from "../time";
import { researchCandidate, type ResearchDeps } from "./research";
import * as store from "./store";
import { shortText } from "../market/short";

export const DRIFT = {
  /** Trading days back to look for the event day. */
  lookbackDays: 10,
  /** The event day's drop against SPY, in %. */
  minDropPct: 5,
  /** Trading days after the event: at least this many before it counts as drift... */
  minDaysAfter: 2,
  /** ...and at most this many (older setups leave the list). */
  maxDaysAfter: 15,
  /** Further fall since the event day's close, against SPY, in %. */
  minFurtherPct: 2,
  /** How far it may have bounced off its low since the event and still count, in %. */
  maxBouncePct: 4,
  minPrice: 5,
  /** Paper hold for researched setups: about 20 trading days. */
  holdCalendarDays: 28,
  /** Research only setups this fresh (trading days after the event), the strongest first, at most this many a day. */
  researchMaxDaysAfter: 7,
  maxResearchPerDay: 2,
};

// ---------------------------------------------------------------- headlines

const EVENTS: Array<[string, RegExp]> = [
  ["FDA / trial setback", /complete response letter|\bCRL\b|FDA (rejects|declines|refuses)|clinical hold|(trial|study) (fails|failed|misses|missed|halted)|did not meet (its |the )?primary endpoint|failed to meet (its |the )?primary/i],
  ["guidance cut", /\b(cuts?|lowers?|slashes|reduces?|withdraws?|suspends?|trims?)\b[^.]{0,40}\b(guidance|outlook|forecast|view)\b|\bguides? (below|lower|weak)|\b(weak|soft|disappointing)(er)? (guidance|outlook|forecast)/i],
  ["earnings miss", /\bmiss(es|ed)?\b[^.]{0,40}\b(estimates?|expectations|consensus|views?)\b|\b(below|short of|lags?) (estimates|expectations|consensus)|\b(eps|revenue|sales) (miss|falls? short)/i],
  ["downgrade", /\bdowngrade[sd]?\b|\bcuts? (to|rating to) (sell|underperform|underweight|neutral|hold|market perform|equal.weight)/i],
  ["investigation / legal", /\b(SEC|DOJ|FTC|FBI|Justice Department|attorney general)\b[^.]{0,30}\b(probe|investigat|charges?|sues|subpoena|raid)|\bsubpoena|\bindict|\bfraud (charges|allegations)|\bwhistleblower/i],
  ["short report", /short.(seller|report)|\b(hindenburg|muddy waters|citron|grizzly|spruce point|culper|wolfpack|fuzzy panda|kerrisdale)\b/i],
  ["dilution / offering", /\b(public|registered|direct|secondary|stock|share|equity|convertible) offering\b|\bprices? [^.]{0,40}offering|at.the.market (offering|program)|\bdilut/i],
  ["distress", /going.concern|\bbankruptcy|chapter 11|\bdefaults? on|delist|\brestat(e|es|ed|ement)|non.reliance|material weakness|covenant (breach|waiver)/i],
  ["executive exit", /\b(ceo|cfo|chief executive|chief financial|founder)\b[^.]{0,40}\b(resigns?|resignation|steps? down|departs?|ousted|fired|terminated|exits?|leaves)\b/i],
  ["dividend cut", /\b(cuts?|slashes|suspends?|eliminates?|halts?)\b[^.]{0,20}\bdividend/i],
  ["lost business / recall", /\brecalls?\b|\bloses? [^.]{0,20}(contract|customer|client)|contract (cancel|terminat)|\bterminat(es|ed) (the |its )?(agreement|partnership|deal)/i],
];
const LAWSUIT_ADS = /class action|on behalf of (investors|shareholders)|shareholder (alert|rights)|securities (fraud|litigation)|investor (alert|reminder)|\b(rosen|pomerantz|levi & korsinsky|bragar|kessler topaz|faruqi|schall|glancy|bronstein|portnoy|robbins|kirby mcinerney|bernstein liebhard|gross law|johnson fistel|holzer)\b/i;
const PRICE_WORDS = /\b(plunges?|plummets?|tumbles?|sinks?|slides?|craters?|tanks?|falls?|drops?|slumps?|sell-?off|trading lower|shares (are )?(down|lower)|52-week low|new low)\b/i;
const NOT_BAD = /\bupgrade|raises? (its |full.year )?(guidance|outlook|forecast)|\bbeats?\b[^.]{0,30}(estimates|expectations)|approv(es|ed|al)\b(?![^.]{0,20}(denied|delay))/i;

/** Brokers whose downgrades the research finds move prices most (large, well-followed firms). */
export const TOP_BROKERS = /\b(goldman|morgan stanley|jpmorgan|j\.p\. morgan|bank of america|bofa|citi(group)?|wells fargo|ubs|barclays|deutsche bank|jefferies|bernstein|evercore|raymond james|rbc)\b/i;

export interface Downgrade { broker: string | null; from: string | null; to: string | null; strength: "strong" | "mild" | "unknown"; topBroker: boolean }

/**
 * Pure: what a downgrade headline says. "Goldman Sachs Downgrades Acceleration Holdings to Neutral" -> Goldman Sachs,
 * to Neutral, mild. Strong = to Sell / Underperform / Underweight / Reduce; mild = to
 * Neutral / Hold / Market Perform / Equal Weight / Sector Perform.
 */
export function downgradeInfo(h: string): Downgrade | null {
  if (!/\bdowngrade|\bcuts? (to|rating to)\b/i.test(h)) return null;
  const broker = h.match(/^([A-Z][\w.&' -]{1,40}?)\s+(downgrades?|cuts?|lowers?)\b/i)?.[1]?.trim() ?? null;
  const to = h.match(/\bto\s+(strong sell|sell|underperform|underweight|reduce|neutral|hold|market perform|sector perform|equal[- ]weight|in[- ]line|peer perform|mixed)\b/i)?.[1] ?? null;
  const from = h.match(/\bfrom\s+(strong buy|buy|outperform|overweight|accumulate|positive|neutral|hold|market perform|equal[- ]weight)\b/i)?.[1] ?? null;
  const strong = !!to && /sell|underperform|underweight|reduce/i.test(to);
  const strength: Downgrade["strength"] = !to ? "unknown" : strong ? "strong" : "mild";
  return { broker, from, to, strength, topBroker: TOP_BROKERS.test(h) };
}

/** Pure: what kind of bad news a headline is. event = a reason the business is worse; pileOn = more bad press (price words, lawsuit ads). */
export function classifyHeadline(h: string): { event: string | null; pileOn: boolean; lawsuitAd: boolean } {
  const lawsuitAd = LAWSUIT_ADS.test(h);
  const event = lawsuitAd ? null : (EVENTS.find(([, re]) => re.test(h))?.[0] ?? null);
  // A headline that is plainly good (an upgrade, raised guidance, a beat) is not counted unless it also names a bad event.
  if (!event && NOT_BAD.test(h)) return { event: null, pileOn: false, lawsuitAd: false };
  return { event, pileOn: !!event || lawsuitAd || PRICE_WORDS.test(h), lawsuitAd };
}

// ---------------------------------------------------------------- detection

export interface DriftSetup {
  symbol: string; eventDate: string; eventKind: string; eventHeadline: string; eventUrl: string | null;
  /** % on the event day, and against SPY. */
  dayPct: number; dayVsSpy: number;
  /** % from the event day's close to the latest close, and against SPY. */
  sincePct: number; sinceVsSpy: number;
  /** % from the close before the event to the latest close. */
  totalPct: number;
  daysAfter: number; downDays: number; bouncePct: number; volRatio: number | null; price: number; asOf: string;
  badAfter: number; lawsuitAds: number; stage: "building" | "established"; score: number;
  /** Schwab short interest when connected: % of float short, days to cover, squeeze risk. */
  short?: import("../market/short").ShortData | null;
  headlines: Array<{ date: string; headline: string; url: string; kind: string | null }>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const etDate = (iso: string) => toEt(new Date(iso)).date;

export interface PriceDrift { d0: number; worst: number; daysAfter: number; sincePct: number; sinceVsSpy: number; bouncePct: number }

/** Pure: the price half of a setup (bars already limited to SPY's trading days): a big drop against SPY, then more falling, no real bounce. */
export function priceDrift(b: DailyBar[], spyC: ReadonlyMap<string, number>, lastDay: string, cfg = DRIFT): PriceDrift | null {
  if (b.length < 25) return null;
  const last = b[b.length - 1];
  if (last.c < cfg.minPrice || last.date !== lastDay) return null;
  // The event day: the biggest one-day drop against SPY in the look-back window, leaving room for drift after it.
  let d0 = -1, worst = 0;
  for (let i = Math.max(1, b.length - cfg.lookbackDays); i <= b.length - 1 - cfg.minDaysAfter; i++) {
    const rel = b[i].c / b[i - 1].c - spyC.get(b[i].date)! / spyC.get(b[i - 1].date)!;
    if (rel < worst) { worst = rel; d0 = i; }
  }
  if (d0 < 0 || -worst * 100 < cfg.minDropPct) return null;
  const daysAfter = b.length - 1 - d0;
  if (daysAfter < cfg.minDaysAfter || daysAfter > cfg.maxDaysAfter) return null;
  const sincePct = (last.c / b[d0].c - 1) * 100;
  const sinceVsSpy = sincePct - (spyC.get(last.date)! / spyC.get(b[d0].date)! - 1) * 100;
  if (sinceVsSpy > -cfg.minFurtherPct) return null;
  const bouncePct = (last.c / Math.min(...b.slice(d0).map((x) => x.c)) - 1) * 100;
  if (bouncePct > cfg.maxBouncePct) return null;
  return { d0, worst, daysAfter, sincePct, sinceVsSpy, bouncePct };
}

/** Pure: the drift setups in a set of daily bars, given SPY's bars, each stock's headlines and recent bad-news 8-Ks. */
export function findDrifts(
  bars: Map<string, DailyBar[]>, spy: DailyBar[], news: Map<string, NewsItem[]>,
  alerts: Array<{ symbol: string | null; filed: string; items: string[] }> = [], cfg = DRIFT,
): DriftSetup[] {
  const spyC = new Map(spy.map((b) => [b.date, b.c]));
  const lastDay = spy.at(-1)?.date ?? "";
  const out: DriftSetup[] = [];
  for (const [symbol, raw] of bars) {
    const b = raw.filter((x) => spyC.has(x.date));
    const p = priceDrift(b, spyC, lastDay, cfg);
    if (!p) continue;
    const ev = b[p.d0], pre = b[p.d0 - 1], last = b[b.length - 1];
    // The news has to explain the drop (no-news drops tend to reverse): an event headline or a bad-news 8-K from the close before the drop through the drop day.
    const inWindow = (d: string) => d >= pre.date && d <= ev.date;
    const items = (news.get(symbol) ?? []).map((n) => ({ n, date: etDate(n.ts), c: classifyHeadline(n.headline) }));
    const eventItems = items.filter((x) => x.c.event && inWindow(x.date)).sort((a, b) => a.n.ts.localeCompare(b.n.ts));
    const k = alerts.find((a) => a.symbol === symbol && inWindow(a.filed));
    if (!eventItems.length && !k) continue;
    const first = eventItems[0];
    const after = items.filter((x) => x.date > ev.date);
    const vols = b.slice(Math.max(0, p.d0 - 20), p.d0).map((x) => x.v);
    const avgV = vols.length ? vols.reduce((a, v) => a + v, 0) / vols.length : 0;
    const setup: DriftSetup = {
      symbol, eventDate: ev.date,
      eventKind: first?.c.event ?? `8-K: ${k!.items[0] ?? "bad-news item"}`,
      eventHeadline: first?.n.headline ?? `${k!.items.join("; ")} (8-K filed ${k!.filed})`,
      eventUrl: first?.n.url ?? null,
      dayPct: r1((ev.c / pre.c - 1) * 100), dayVsSpy: r1(p.worst * 100),
      sincePct: r1(p.sincePct), sinceVsSpy: r1(p.sinceVsSpy), totalPct: r1((last.c / pre.c - 1) * 100),
      daysAfter: p.daysAfter, downDays: b.slice(p.d0 + 1).filter((x, i) => x.c < b[p.d0 + i].c).length, bouncePct: r1(p.bouncePct),
      volRatio: avgV > 0 ? r1(ev.v / avgV) : null, price: last.c, asOf: last.date,
      badAfter: after.filter((x) => x.c.pileOn && !x.c.lawsuitAd).length, lawsuitAds: after.filter((x) => x.c.lawsuitAd).length,
      stage: p.daysAfter <= 5 ? "building" : "established", score: 0,
      headlines: items.filter((x) => x.c.pileOn).sort((a, b) => b.n.ts.localeCompare(a.n.ts)).slice(0, 6).map((x) => ({ date: x.date, headline: x.n.headline, url: x.n.url, kind: x.c.event ?? (x.c.lawsuitAd ? "lawsuit ad" : null) })),
    };
    // Stronger: more further fall, steadier (more down days), more bad news after the event, a heavy-volume event day.
    setup.score = r1(-setup.sinceVsSpy + (setup.downDays / p.daysAfter) * 4 + Math.min(setup.badAfter, 5) * 0.6 + Math.min(setup.volRatio ?? 1, 5) * 0.4);
    out.push(setup);
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- the hourly scan

interface Seen { [date: string]: string[] }

/** Keep a rolling record (14 days) of symbols worth scanning: the day's biggest losers and stocks in negative headlines. */
async function remember(key: string, date: string, symbols: string[]): Promise<string[]> {
  const prev = (await store.cacheGet<Seen>(key).catch(() => null))?.data ?? {};
  const merged: Seen = { ...prev, [date]: [...new Set([...(prev[date] ?? []), ...symbols])].slice(0, 400) };
  const keep = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14));
  await store.cachePut(key, keep).catch(() => undefined);
  return [...new Set(Object.values(keep).flat())];
}

const okSymbol = (s: string) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s);

/** The scan: universe → bars → setups → their headlines → confirmed setups. Read-only market data. */
export async function scanDrift(data: MarketData, now = new Date()): Promise<{ asOf: string; scanned: number; setups: DriftSetup[] }> {
  const today = toEt(now).date;
  const fresh = await data.getNews([], new Date(now.getTime() - 26 * 3600_000), now, 1000).catch(() => [] as NewsItem[]);
  const badSyms = fresh.filter((n) => n.symbols.length && n.symbols.length <= 3 && classifyHeadline(n.headline).pileOn).flatMap((n) => n.symbols);
  const losers = data.getMovers ? (await data.getMovers(50).catch(() => ({ gainers: [], losers: [] }))).losers.map((m) => m.symbol) : [];
  const [seenNews, seenLosers, alerts] = await Promise.all([
    remember("drift:news-symbols", today, badSyms), remember("drift:losers", today, losers),
    store.filingAlertsSince(addDays(today, -21)).catch(() => []),
  ]);
  const bad8k = alerts.filter((a) => a.kind === "8-K" && a.symbol);
  const universe = [...new Set([...Object.values(UNIVERSE).flat(), ...CHATTER_UNIVERSE.map((u) => u.symbol), ...seenNews, ...seenLosers, ...bad8k.map((a) => a.symbol!)])].filter(okSymbol);
  const all = await data.getDailyBars(["SPY", ...universe.filter((s) => s !== "SPY")], addDays(today, -75), today);
  const by = new Map<string, DailyBar[]>();
  for (const b of all) by.set(b.symbol, [...(by.get(b.symbol) ?? []), b]);
  const spy = by.get("SPY") ?? [];
  by.delete("SPY");
  // Prices first; headlines are fetched only for the stocks that pass.
  const spyC = new Map(spy.map((b) => [b.date, b.c]));
  const lastDay = spy.at(-1)?.date ?? "";
  const candidates = [...by.keys()].filter((s) => priceDrift(by.get(s)!.filter((x) => spyC.has(x.date)), spyC, lastDay));
  const news = new Map<string, NewsItem[]>();
  for (let i = 0; i < candidates.length; i += 25) {
    const chunk = candidates.slice(i, i + 25);
    const items = await data.getNews(chunk, new Date(`${addDays(today, -24)}T00:00:00Z`), now, 800).catch(() => [] as NewsItem[]);
    for (const n of items) for (const s of n.symbols) if (chunk.includes(s)) news.set(s, [...(news.get(s) ?? []), n]);
  }
  const setups = findDrifts(new Map(candidates.map((s) => [s, by.get(s)!])), spy, news, bad8k.map((a) => ({ symbol: a.symbol, filed: a.filed, items: a.items })));
  // Short interest (Nasdaq; % of shares when Schwab is connected), for the squeeze check.
  if (setups.length) {
    const sd = await import("../market/short").then(({ shortData }) => shortData(setups.slice(0, 25).map((s) => s.symbol))).catch(() => new Map());
    for (const s of setups) s.short = sd.get(s.symbol) ?? null;
  }
  // When each setup first appeared (for the "new" badge on the Drift tab).
  try {
    const seen = (await store.cacheGet<Record<string, string>>("drift:first-seen"))?.data ?? {};
    const nowIso = now.toISOString(), cutoff = new Date(now.getTime() - 40 * 86400_000).toISOString();
    const next: Record<string, string> = Object.fromEntries(Object.entries(seen).filter(([, at]) => at > cutoff));
    for (const s of setups) next[`${s.symbol}|${s.eventDate}`] ??= nowIso;
    await store.cachePut("drift:first-seen", next);
  } catch {
    /* the badge is optional */
  }
  return { asOf: spy.at(-1)?.date ?? today, scanned: by.size, setups };
}

/** Pure: a setup's short-interest line for people and the research step. */
export function shortLine(s: DriftSetup): string | null {
  return shortText(s.short);
}

// ---------------------------------------------------------------- research

const EVIDENCE = "The evidence for negative-news drift: stocks with bad public news keep drifting down for months while big moves without news tend to reverse (Chan 2003); bad news travels slowly where analyst coverage is thin, so the drift is larger in small and less-covered stocks (Hong, Lim & Stein 2000); negative wording in news predicts lower earnings and returns the market is slow to price (Tetlock, Saar-Tsechansky & Macskassy 2008), and AI-read headline sentiment predicts returns most for negative news and small caps (Lopez-Lira & Tang); holders sitting on gains sell bad news slowly, stretching the drift (Frazzini 2006).";

/** Pure: what the research step reads for one setup. */
export function driftContext(s: DriftSetup): string {
  return [
    `A down-drift setup in ${s.symbol}: on ${s.eventDate} it fell ${s.dayPct}% (${s.dayVsSpy}% against SPY) on ${s.eventKind} news: "${s.eventHeadline}".`,
    `Since then: ${s.sincePct}% more (${s.sinceVsSpy}% against SPY) over ${s.daysAfter} trading days, down on ${s.downDays} of them, ${s.bouncePct}% off its low; ${s.totalPct}% in total from the close before the news; last $${s.price} on ${s.asOf}.${s.volRatio ? ` The event day traded ${s.volRatio}x its usual volume.` : ""}`,
    `Negative headlines after the event: ${s.badAfter}${s.lawsuitAds ? `, plus ${s.lawsuitAds} law-firm lawsuit ads` : ""}.`,
    shortLine(s) ? `Short interest: ${shortLine(s)}. A crowded short can squeeze hard on any good news; weigh that against the drift.` : "Short interest: not available.",
    s.headlines.length ? `Recent bad headlines:\n${s.headlines.map((h) => `- ${h.date}${h.kind ? ` [${h.kind}]` : ""} ${h.headline}`).join("\n")}` : "",
    EVIDENCE,
    `Questions: is the bad news still unfolding (more to come: a dated hearing, an FDA or court date, the next earnings date, a financing that has to close, an index deletion, a credit downgrade)? Is the business actually worse, or is it a one-off the market has fully priced? Who still has to sell (funds that cannot hold it, index deletions, margin calls, insiders)? Is there a reason it reverses (a buyback, a takeover, insider buying, heavy short interest that can squeeze)? If it is dangerous or impractical to short (hard to borrow, a squeeze, under $5, a tiny float), say so; puts or simply avoiding the stock may be the expression.`,
    `Proposed: short ${s.symbol}, held about 20 trading days (set the time limit near ${DRIFT.holdCalendarDays} days unless a nearer dated catalyst decides it).`,
  ].filter(Boolean).join("\n");
}

/** Research the freshest, strongest setups not researched in the last 30 days (at most `max` now, DRIFT.maxResearchPerDay a day). */
export async function runDriftResearch(deps: ResearchDeps, setups: DriftSetup[], max = 1): Promise<{ researched: Array<{ term: string; outcome: string; cardId?: number; reason?: string }>; error: string | null }> {
  const settings = await store.loadSettings();
  if (!settings.enabled) return { researched: [], error: "scout is switched off in Settings" };
  const [recent, lastDay] = await Promise.all([store.recentTerms(30), store.recentTerms(1)]);
  const doneToday = [...lastDay].filter((t) => t.startsWith("drift: ")).length;
  const room = Math.max(0, Math.min(max, DRIFT.maxResearchPerDay - doneToday));
  const out = { researched: [] as Array<{ term: string; outcome: string; cardId?: number; reason?: string }>, error: null as string | null };
  const todo = setups.filter((s) => s.daysAfter <= DRIFT.researchMaxDaysAfter && ![...recent].some((t) => t.startsWith(`drift: ${s.symbol.toLowerCase()} `)));
  for (const s of todo.slice(0, room)) {
    const r = await researchDrift(deps, s);
    out.researched.push(r);
    if (r.outcome === "capped") out.error = r.reason ?? "capped"; // queued; the rest are queued too
  }
  return out;
}

/** Research one setup as the down-drift desk. */
export async function researchDrift(deps: ResearchDeps, s: DriftSetup): Promise<{ term: string; outcome: string; cardId?: number; status?: string; reason?: string }> {
  const term = `drift: ${s.symbol} ${s.eventKind}`.slice(0, 80);
  const trigger: Signal[] = [{ source: "news", metric: `drift:${s.symbol}`, value: s.sinceVsSpy, baseline: null, changeVs12m: null, asOf: s.asOf, note: `${s.symbol} ${s.dayPct}% on ${s.eventDate} (${s.eventKind}), ${s.sincePct}% more over ${s.daysAfter} trading days` }];
  const r = await researchCandidate({ origin: "scout", term, kindHint: "event", tickersHint: [s.symbol], observation: null, trigger, context: driftContext(s), proposedDirection: "short" }, deps);
  return r.outcome === "card" ? { term, outcome: `card: ${r.card.status}`, cardId: r.card.id, status: r.card.status } : { term, outcome: r.outcome, reason: r.reason };
}
