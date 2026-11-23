/**
 * Stories: discrete shocks in the headline stream (a CEO scandal, a war, a
 * ban, a pivot, a regulator's move) and the trades they imply, direct and
 * one step away. Detection is mechanical; the model lays out the trades;
 * every trade goes through the normal research step and gates, so most story
 * cards will be logged as "late" and tracked on paper. The scoring page then
 * shows whether story trades beat SPY, which is the honest answer to whether
 * this style works.
 */
import { z } from "zod";
import type { MarketData, NewsItem } from "../alpaca";
import { isMainstream } from "../sources/news";
import type { Signal } from "../sources";
import { dateStr, daysAgo } from "../sources/types";
import { addDays, toEt } from "../time";
import { type Attention, type CoverageTrend, coverageTrend, publicAttention } from "./attention";
import { preferencesText } from "./preferences";
import { STALE_FROM, staleness, stalenessLabel } from "./staleness";
import { researchCandidate, type ResearchDeps } from "./research";
import { normalizeTicker } from "./tickers";
import * as store from "./store";

// ------------------------------------------------------------- detection

/** Wording that marks a shock rather than ordinary coverage. */
export const SHOCK = /\b(shot|killed|dies|death|assassinat\w*|resign\w*|steps? down|ousted?|fired|scandal|affair|indict\w*|arrest\w*|charged|fraud|probe|investigat\w*|subpoena|lawsuit|sued|verdict|ruling|antitrust|ban(?:s|ned)?|block(?:s|ed)|tariffs?|sanction\w*|executive order|regulat\w*|legislation|bill passes|war|strikes?|missile|ceasefire|invasion|blockade|outage|hack(?:ed)?|breach|recall|halt(?:s|ed)?|bankrupt\w*|chapter 11|default|downgrade|pivot\w*|guidance cut|cuts? (?:guidance|outlook|forecast)|FDA (?:approv|reject|warn)\w*|short report|short seller|espionage|spying|spies|spy (?:ring|agency|probe|case|links?)|national security|export controls?|smuggl\w*)\b/i;

/**
 * Institutions acting on a story: each one is a new stage and a fresh catalyst
 * (a board hiring outside investigators, a congressional committee, a
 * regulator, prosecutors, a resignation). Lower-cased matches.
 */
export const ESCALATION = /\b(board (?:of directors )?(?:launch\w*|open\w*|hire\w*|retain\w*|order\w*|review\w*|investigat\w*)|special committee|independent (?:review|investigation|counsel)|outside (?:counsel|lawyers|investigat\w*|law firm)|law firm|former (?:U\.?S\.? )?(?:attorney|prosecutor)|(?:house|senate|congressional) (?:committee|panel|probe|investigat\w*|letter|hearing)|committees?|lawmakers|congress(?:ional)?|senators?|briefing|hearing|testify|subpoena\w*|justice department|doj|\bsec\b|ftc|commerce department|bureau of industry and security|regulators?|attorneys? general|indict\w*|charged|resign\w*|steps? down|ousted|interim ceo|placed on leave|recus\w*)\b/gi;

/** Distinct institution-acting phrases in a text, lower-cased. */
export function escalationWords(text: string): string[] {
  return [...new Set([...text.matchAll(ESCALATION)].map((m) => m[1].toLowerCase().replace(/\s+/g, " ")))];
}

/** Deal and liquidity events: often about a private company, so the listed winners are its holders, not the headline's ticker. */
export const CATALYST = /\b(IPO|initial public offering|S-1|files? (?:confidentially )?(?:to go public|for (?:an )?IPO)|direct listing|goes public|going public|funding round|raises \$[\d.]+ ?(?:billion|bn|B)|tender offer|valuation of \$|valued at \$|acquires?|acquisition|takeover|buyout|merger|spin-?off|stake)\b/i;

/** First shock or catalyst word in a text, lower-cased; null if none. */
export function eventWord(text: string): string | null {
  const m = SHOCK.exec(text) ?? CATALYST.exec(text);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (/^(ipo|initial public offering|s-1|direct listing|goes public|going public)$/.test(w) || /go public|for (an )?ipo/.test(w)) return "ipo";
  if (/funding round|raises|valuation of|valued at|tender offer/.test(w)) return "funding";
  if (/acquire|acquisition|takeover|buyout|merger/.test(w)) return "deal";
  return w;
}

export interface Story {
  /** Stable key for the day: the ticker, or the shock word for macro stories. */
  key: string;
  label: string;
  symbols: string[];
  stories: number;
  mainstream: number;
  shockHits: number;
  /** Headlines with an institution acting (board, Congress, regulator, prosecutor, resignation) and the phrases seen. */
  escalationHits: number;
  escalation: string[];
  /** Set by runStories when the desk has read this story before: earlier days, and the stage number when an institution acted. */
  history?: Array<{ date: string; stage: number; summary: string }>;
  stage?: number;
  /** Set by runStories: the ticker's coverage over the last days (building = growing every day), and public attention to the people named earlier. */
  coverage?: CoverageTrend;
  attention?: Attention[];
  /** Measured by code: how much today's headlines repeat the ticker's previous stories (0 new … 1 repeated). */
  staleness?: number | null;
  /** Time of the newest headline in the story (ISO). */
  latest: string;
  /** Newest first; `at` is the headline's full ISO timestamp. */
  headlines: Array<{ at: string; headline: string; source: string; symbols: string[] }>;
}

export interface DetectOptions {
  /** Trailing daily average of stories per ticker, when known (from stored history). */
  dailyAvg?: Record<string, number>;
  minMainstream?: number;
  minStories?: number;
  spikeMultiple?: number;
  maxStories?: number;
  /** Tickers with a story in the last 30 days: a new headline there with an institution acting needs only 2 mainstream headlines. */
  openTickers?: Set<string>;
  /** Open-story tickers whose coverage is building: like a new stage, they need only 2 mainstream headlines. */
  building?: Set<string>;
}

/** Pure: find the day's stories. Ticker stories need mainstream coverage and shock wording or a spike; macro stories are shock wording across many headlines with few tickers. */
export function detectStories(items: NewsItem[], opts: DetectOptions = {}): Story[] {
  const { dailyAvg = {}, minMainstream = 3, minStories = 6, spikeMultiple = 4, maxStories = 8, openTickers = new Set<string>(), building = new Set<string>() } = opts;
  const byTicker = new Map<string, Story>();
  const macro = new Map<string, Story>();
  for (const n of items) {
    const text = `${n.headline} ${n.summary}`;
    const shock = eventWord(text);
    const esc = escalationWords(text);
    const main = isMainstream(n);
    const h = { at: n.ts, headline: n.headline, source: n.source, symbols: n.symbols };
    if (n.symbols.length > 0 && n.symbols.length <= 6) {
      for (const s of n.symbols) {
        const t = byTicker.get(s) ?? { key: s, label: s, symbols: [s], stories: 0, mainstream: 0, shockHits: 0, escalationHits: 0, escalation: [], latest: "", headlines: [] };
        t.stories++;
        if (n.ts > t.latest) t.latest = n.ts;
        if (main) t.mainstream++;
        if (shock) t.shockHits++;
        if (esc.length) {
          t.escalationHits++;
          for (const w of esc) if (!t.escalation.includes(w)) t.escalation.push(w);
        }
        if (t.headlines.length < 8 && (shock || main || esc.length)) t.headlines.push(h);
        byTicker.set(s, t);
      }
    } else if (shock && n.symbols.length === 0) {
      const m = macro.get(shock) ?? { key: `macro:${shock}`, label: shock, symbols: [], stories: 0, mainstream: 0, shockHits: 0, escalationHits: 0, escalation: [], latest: "", headlines: [] };
      m.stories++;
      m.shockHits++;
      if (n.ts > m.latest) m.latest = n.ts;
      if (main) m.mainstream++;
      // Deal buckets collect many unrelated headlines: keep more, mainstream first.
      const cap = ["ipo", "funding", "deal"].includes(shock) ? 15 : 8;
      if (m.headlines.length < cap) m.headlines.push(h);
      else if (main) {
        const i = m.headlines.findIndex((x) => !/reuters|bloomberg|wsj|cnbc|ft|nytimes|apnews/i.test(x.source));
        if (i >= 0) m.headlines[i] = h;
      }
      macro.set(shock, m);
    }
  }
  const out: Story[] = [];
  for (const t of byTicker.values()) {
    const avg = dailyAvg[t.key];
    const spike = avg ? t.stories >= spikeMultiple * avg : false;
    const newStage = openTickers.has(t.key) && (t.escalationHits >= 1 || building.has(t.key)) && t.mainstream >= 2;
    if (newStage || (t.mainstream >= minMainstream && (t.shockHits >= 2 || spike || t.stories >= minStories * 2))) out.push(t);
  }
  for (const m of macro.values()) {
    // A single big private-company liquidity event is a story; it needs mainstream pick-up, not volume.
    const deal = ["macro:ipo", "macro:funding", "macro:deal"].includes(m.key);
    if ((m.stories >= minStories && m.mainstream >= minMainstream) || (deal && m.mainstream >= 2)) out.push(m);
  }
  // The strongest stories make the cut; they are then listed freshest first, headlines newest first.
  return out
    .sort((a, b) => b.shockHits * 3 + b.escalationHits * 3 + b.mainstream - (a.shockHits * 3 + a.escalationHits * 3 + a.mainstream))
    .slice(0, maxStories)
    .map((s) => ({ ...s, headlines: s.headlines.slice().sort((a, b) => b.at.localeCompare(a.at)) }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

/** Pure: when no story qualifies, the busiest tickers with the counts the rule looks at (so the run says why). */
export function nearestStories(items: NewsItem[], n = 4): string {
  const top = detectStories(items, { minMainstream: 0, minStories: 0, maxStories: n }).filter((s) => !s.key.startsWith("macro:"));
  if (!top.length) return items.length ? "no headline carried a ticker" : "no headlines";
  return `closest: ${top.map((s) => `${s.key} ${s.stories} headlines (${s.mainstream} mainstream, ${s.shockHits} with shock wording)`).join("; ")}`;
}

// ---------------------------------------------------------------- triage

export const STORY_SYSTEM_PROMPT = `You are the story desk of a paper-only "trend scout". You are shown breaking stories from a market news stream: shocks such as a CEO scandal, exit or death, a war or ceasefire, a ban, tariff or sanction, a regulator's move, an indictment, a recall, a strategic pivot, a guidance cut, and deal events such as an IPO filing, a big funding round or an acquisition. Some are follow-ups on stories seen days ago whose stock has barely moved while the coverage stayed loud. For each story you lay out the trades it implies, the way an event-driven trader would.

Predicting the event is not the job; asking a better second question is. Before naming trades, ask of each story:
1. What does it reveal, not just what happened? The headline may be a crime, a resignation or a scandal; the signal may be what the reaction shows: how intensely the public, customers, employees or lawmakers feel, or what the timing implies (a CEO leaving a week before earnings).
2. Whose incentives just changed? Politicians and regulators who now have a popular target, rivals who can take share, customers who can walk, boards and prosecutors with a reason to dig. Their responses (hearings, bills, investigations, policy reversals, boycotts) arrive over weeks and the market tends to price them late. After good news, ask who is now forced to buy or sell, but treat flows with care: moves driven by flows (index changes, offerings, rebalances) tend to reverse once the flow is done, and the S&P 500 addition effect has shrunk to about nothing (most additions are migrations from the MidCap 400, whose funds sell as the S&P funds buy). What still works is small and specific: non-migration additions large against the free float, and the reversal after the effective date in small, thinly traded index additions and deletions. Short covering and underweight funds chasing a stock that truly re-rated on new fundamentals can carry a move; analysts raising targets after a rally add little.
3. Is the market's reaction smaller than the story's intensity? A flat stock while coverage and anger keep growing is the gap to look for. A stock that already fell 15% on the day may have priced it.
4. Is the company priced as one person's company? When the valuation rests on a founder-CEO, any threat to that person is a threat to the valuation, and the market tends to treat it as unlikely until it suddenly is not.
5. What else is moving the stock right now (an inflation print, an election, a sector sell-off, downgrades)? Name it, so a result is not credited to the story alone, and compare against the stock's peers: a stock falling while its rivals rise is the story; everything falling together is the market.

Attention that grows every day can be a signal before any institution acts, but only when the coverage carries new facts: a scandal that dominates the news more each day with fresh disclosures forces a response sooner or later. Re-reported news is the opposite: recaps, follow-ups and "why X is moving" stories that repeat what was already known get overtraded by retail investors and tend to reverse (Tetlock). You are shown a measured staleness for each story (how much today's headlines repeat the ticker's earlier ones); growing coverage that is mostly stale is a fade, not a follow.

Classify every story before choosing trades, because the classification decides follow or fade:
- "novelty": "new" (a new fact) or "stale" (repeats what was already reported).
- "nature": "fundamental" (cash flows: contracts with dollar values, guidance, regulatory outcomes, legal findings) or "flow" (index changes, offerings, rebalances, options expiry) or "noise" (no identifiable new fact).
- "complexity": "simple" (one transparent fact the market reads at once: an earnings number, a partnership, a trial result) or "complex" (multi-step: read-throughs, insider patterns, technical or legal detail).
- Default play: follow new, fundamental news, more so when it is bad, complex, or about a small or opaque company (bad news drifts for weeks to months; good news less); fade stale, flow-driven and no-news moves (they tend to reverse within days to a week). Transparent, binary news (trial results, partnerships, earnings) is priced almost at once: little drift to harvest.
- Horizons that match the evidence: read-throughs to suppliers and peers about 5 trading days; bad-news drift weeks to months; flow trades out at the flow date; fades of stale or no-news moves about a week.

Stories come in stages. The first headline is rarely the whole story: once an institution acts (a board hires outside investigators, a congressional committee asks for a briefing, a regulator or prosecutor opens a case, an executive resigns), the matter has to go somewhere, and every reporter starts digging. A board that hires a former prosecutor does not clear anyone in a week. When you are shown earlier stages of a story, treat the new one as a fresh catalyst on an old story: ask who has to act next (the board, Congress, export-control or other regulators, prosecutors, reporters), what that next step would do to the price, and whether the move so far has priced it. The cleanest entry is usually right after the first institution acts, before most of the move; by the late stages options are expensive.

Then the trades:
- Direct: the named company or the obvious fund (an oil fund on a war, a defense name on an attack), with direction.
- Second-order: who wins or loses one step away that the headlines are not about yet (a rival that takes share, a supplier, a customer, a platform that loses traffic).
- Reaction: who has to respond to the reaction, and what that response does to which listed companies (an industry facing a political backlash, the businesses a regulator will target, the peers a probe may spread to). Horizon in weeks, not days.
- Private-company liquidity events (an IPO filing or pricing, a large funding round or tender offer, an acquisition): the listed winners are the companies that hold stakes, strategic investors and corporate venture arms, especially where the stake is a large share of the holder's market value. Name the holder, say roughly what the stake may be worth against its market cap if you know, and flag lock-ups and dilution as risks.
- For each trade: how long the repricing should take, what would prove it wrong, and why the market may still be mispricing it after the first move (forced sellers, a slow-burning investigation, an index or fund flow, a second shoe to drop, a political process that has not started yet).

For every story also give "company" (the main listed company's name as Wikipedia titles it; empty for a macro story) and "people" (at most three people at the centre of the story, full names as Wikipedia titles them; empty if none), so the scout can measure public attention.

For every trade also give "play": "follow" (ride the information) or "fade" (bet on the move reversing).

Rules: at most two trades per story, a credible reaction or second-order trade preferred over the obvious direct one. Skip stories that are noise, already fully priced, or have no listed exposure, and say why. Trades are tracked and scored as shares against SPY. Tickers must be listed on a US exchange: for a foreign company use its exchange-listed US ADR (TSM, ASML, SONY), never the home-exchange symbol, and not an OTC-only ADR such as BESIY, which cannot be priced or paper-traded. Be concrete and short.`;

export const storyTriageSchema = z.object({
  stories: z.array(z.object({
    key: z.string().min(1),
    summary: z.string().min(1).max(400),
    company: z.string().max(120).default(""),
    people: z.array(z.string().max(80)).max(5).default([]),
    novelty: z.enum(["new", "stale"]).default("new"),
    nature: z.enum(["fundamental", "flow", "noise"]).default("fundamental"),
    complexity: z.enum(["simple", "complex"]).default("simple"),
    skip: z.boolean(),
    skip_reason: z.string().max(300),
    trades: z.array(z.object({
      ticker: z.string().min(1),
      direction: z.enum(["long", "short"]),
      role: z.enum(["direct", "second_order", "reaction"]),
      play: z.enum(["follow", "fade"]).default("follow"),
      horizon_days: z.number().int().min(1).max(180),
      thesis: z.string().min(1).max(500),
      why_not_priced: z.string().min(1).max(400),
      invalidation: z.string().min(1).max(300),
    })).max(2),
  })).max(10),
});
export type StoryTriage = z.infer<typeof storyTriageSchema>;

export const STORY_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["stories"],
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["key", "summary", "company", "people", "novelty", "nature", "complexity", "skip", "skip_reason", "trades"],
        properties: {
          key: { type: "string", description: "the story key exactly as given" },
          summary: { type: "string", description: "what happened, one or two sentences" },
          company: { type: "string", description: "the main listed company's name as Wikipedia titles it; empty for a macro story" },
          novelty: { type: "string", enum: ["new", "stale"] }, nature: { type: "string", enum: ["fundamental", "flow", "noise"] }, complexity: { type: "string", enum: ["simple", "complex"] },
          people: { type: "array", items: { type: "string" }, description: "up to three people at the centre of the story, full names as Wikipedia titles them; empty if none" },
          skip: { type: "boolean" },
          skip_reason: { type: "string", description: "empty when not skipped" },
          trades: {
            type: "array", description: "at most two; empty when skipped",
            items: {
              type: "object", additionalProperties: false, required: ["ticker", "direction", "role", "play", "horizon_days", "thesis", "why_not_priced", "invalidation"],
              properties: {
                ticker: { type: "string", description: "US ticker symbol only, e.g. NVDA or BRK.B; no $ sign, no exchange prefix" }, direction: { type: "string", enum: ["long", "short"] }, role: { type: "string", enum: ["direct", "second_order", "reaction"] }, play: { type: "string", enum: ["follow", "fade"] },
                horizon_days: { type: "integer", description: "1 to 180" }, thesis: { type: "string" }, why_not_priced: { type: "string" }, invalidation: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function buildStoryPrompt(stories: Story[], date: string, preferences: string | null = null): string {
  const L = [`Date: ${date}. ${stories.length} stories from the last 24 hours of the news stream.`];
  if (preferences) L.push(`\n${preferences}`);
  for (const s of stories) {
    L.push(`\n## ${s.key} — ${s.symbols.length ? s.symbols.join(", ") : "macro"}: ${s.stories} headlines, ${s.mainstream} mainstream, ${s.shockHits} with shock wording${s.escalation.length ? `, institutions acting: ${s.escalation.slice(0, 6).join(", ")}` : ""}`);
    if (s.staleness !== undefined) L.push(`Measured ${stalenessLabel(s.staleness)}.`);
    if (s.coverage) L.push(`${s.symbols[0] ?? s.key} ${s.coverage.line}.${s.coverage.building ? " What will this growing attention force to happen next?" : ""}`);
    for (const x of s.attention ?? []) L.push(`Public attention: ${x.line}.`);
    if (s.history?.length) {
      L.push(s.stage ? `Stage ${s.stage} of a story first seen ${s.history[0].date}: an institution has acted. Who has to act next?` : s.coverage?.building ? `Building story, first seen ${s.history[0].date}: no institution acting yet, but the coverage keeps growing.` : `Seen before (first ${s.history[0].date}); no institution acting in today's headlines.`);
      for (const e of s.history) L.push(`  earlier, ${e.date} (stage ${e.stage}): ${e.summary}`);
    }
    for (const h of s.headlines) L.push(`- ${h.at.slice(11, 16)}Z [${h.source}${h.symbols.length ? ` · ${h.symbols.join(",")}` : ""}] ${h.headline}`);
  }
  L.push("\nAsk the three questions of each story, then reply with the JSON object, one entry per story key.");
  return L.join("\n");
}

/** Parse the desk's reply. A trade with a ticker that is not a US symbol is dropped (noted in `dropped`), never the whole reply. */
export function parseStoryTriage(text: string): StoryTriage & { dropped: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("story reply is not valid JSON");
  }
  const r = storyTriageSchema.safeParse(raw);
  if (!r.success) throw new Error(`story reply failed validation: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const dropped: string[] = [];
  const stories = r.data.stories.map((s) => {
    const trades = s.trades.flatMap((t) => {
      const ticker = normalizeTicker(t.ticker);
      if (!ticker) {
        dropped.push(`${s.key}: ${t.ticker}`);
        return [];
      }
      return [{ ...t, ticker }];
    });
    return { ...s, trades, skip: s.skip || (!s.trades.length ? s.skip : trades.length === 0), skip_reason: s.skip ? s.skip_reason : trades.length === 0 && s.trades.length ? `no US-listed ticker among the proposed trades (${s.trades.map((t) => t.ticker).join(", ")})` : s.skip_reason };
  });
  return { stories, dropped };
}

// ------------------------------------------------------------------- run

export const STORY_COOLDOWN_DAYS = 3;
export const storyTerm = (key: string, ticker: string) => `story: ${key} → ${ticker}`;

export interface StoriesReport {
  date: string;
  headlinesRead: number;
  /** How many of the headlines came from the Alpaca stream and from the fast sources (wires, 8-Ks, world news). */
  fromStream?: number;
  fromFast?: number;
  /** The stream's publishers by headline count (a publisher missing from the mainstream list stops every story). */
  streamSources?: string;
  /** When nothing was detected: the busiest tickers and why none qualified. */
  nearest?: string;
  detected: Array<{ key: string; symbols: string[]; stories: number; mainstream: number; shockHits: number; stage: number | null; escalation: string[]; building: boolean; coverage: string | null; staleness: number | null; latest: string; sample: string[]; samples: Array<{ at: string; headline: string }> }>;
  triage: Array<{ key: string; summary: string; skipped: string | null; labels?: { novelty: string; nature: string; complexity: string }; trades: Array<{ ticker: string; direction: string; role: string; play?: string; horizon_days: number }>; attention?: string[] }>;
  researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>;
  error: string | null;
}

/** Detect today's stories, lay out the trades, research each as an event card. Safe to run hourly: a story's trade is researched once per 3 days. */
export async function runStories(deps: ResearchDeps, max = 4): Promise<StoriesReport> {
  const et = toEt(deps.now);
  const report: StoriesReport = { date: et.date, headlinesRead: 0, detected: [], triage: [], researched: [], error: null };
  if (!deps.data) {
    report.error = "news stream not configured (Alpaca keys)";
    return report;
  }
  const settings = await store.loadSettings();
  if (!settings.enabled) {
    report.error = "scout is switched off in Settings";
    return report;
  }
  let items: NewsItem[];
  try {
    items = await deps.data.getNews([], daysAgo(deps.now, 1), deps.now, 1500);
    // The fast sources too (press wires, SEC 8-Ks, Nasdaq halts, Finnhub): stories are not held back when Alpaca's stream lags.
    const fast = await import("../sources/wires").then(({ fastNews }) => fastNews(deps.env, deps.fetchImpl, deps.now)).catch(() => [] as NewsItem[]);
    const seen = new Set(items.map((n) => n.headline.toLowerCase()));
    report.fromStream = items.length;
    const bySource = new Map<string, number>();
    for (const n of items) bySource.set(n.source || "(no source)", (bySource.get(n.source || "(no source)") ?? 0) + 1);
    report.streamSources = [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, k]) => `${name} ${k}`).join(", ");
    items = [...items, ...fast.filter((n) => !seen.has(n.headline.toLowerCase()))];
    report.fromFast = items.length - report.fromStream;
  } catch (err) {
    report.error = `news stream: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }
  report.headlinesRead = items.length;
  const dailyAvg = await store.tickerDailyAverages(addDays(et.date, -30), et.date);
  const events = await store.storyEventsSince(addDays(et.date, -30));
  const openTickers = new Set(events.filter((e) => !e.key.startsWith("macro:")).map((e) => e.key));
  const recentCounts = await store.tickerCounts([...openTickers], addDays(et.date, -6), et.date);
  const building = new Set([...openTickers].filter((t) => coverageTrend(recentCounts.filter((c) => c.symbol === t), et.date).building));
  const stories = detectStories(items, { dailyAvg, openTickers, building });
  const readToday = new Set(events.filter((e) => e.etDate === et.date).map((e) => e.key));
  const storyCounts = await store.tickerCounts(stories.filter((s) => !s.key.startsWith("macro:")).map((s) => s.key), addDays(et.date, -6), et.date);
  for (const s of stories) {
    attachHistory(s, events, et.date);
    if (!s.key.startsWith("macro:")) s.coverage = coverageTrend(storyCounts.filter((c) => c.symbol === s.key), et.date);
  }
  // Staleness: today's headlines against the ticker's ten previous stories (before the last 24 hours).
  for (const s of stories.filter((x) => !x.key.startsWith("macro:"))) {
    const earlier = await deps.data.getNews([s.key], daysAgo(deps.now, 30), daysAgo(deps.now, 1), 10).catch(() => []);
    s.staleness = staleness(s.headlines.map((h) => h.headline), earlier.map((n) => n.headline));
  }
  report.detected = stories.map((s) => ({ key: s.key, symbols: s.symbols, stories: s.stories, mainstream: s.mainstream, shockHits: s.shockHits, stage: s.stage ?? null, escalation: s.escalation.slice(0, 6), building: !!s.coverage?.building, coverage: s.coverage?.line ?? null, staleness: s.staleness ?? null, latest: s.latest, sample: s.headlines.slice(0, 3).map((h) => h.headline), samples: s.headlines.slice(0, 3).map((h) => ({ at: h.at, headline: h.headline })) }));
  await store.saveTickerCounts(et.date, items);
  if (!stories.length) {
    report.nearest = nearestStories(items);
    return report;
  }

  const recent = await store.recentTerms(STORY_COOLDOWN_DAYS);
  // A new stage (an institution acted) or a building story (coverage growing every day) skips the 3-day cooldown, once a day per story.
  // Growing coverage only counts when it carries new facts; stale re-reporting is a fade, not a reason to look again.
  const again = (s: Story) => !!s.stage || (!!s.history?.length && !!s.coverage?.building && (s.staleness ?? 0) < STALE_FROM);
  const fresh = stories.filter((s) => (again(s) ? !readToday.has(s.key) : ![...recent].some((t) => t.startsWith(`story: ${s.key.toLowerCase()} `))));
  if (!fresh.length) {
    report.error = `all ${stories.length} stories were researched in the last ${STORY_COOLDOWN_DAYS} days`;
    return report;
  }
  const spend = await store.spendOn(et.date);
  if (spend.cost >= settings.dailyCapUsd) {
    report.error = `daily LLM cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd})`;
    return report;
  }

  let triage: StoryTriage | null = null;
  const preferences = preferencesText(await store.recentFeedback());
  fresh.sort((a, b) => Number(!!b.stage) * 2 + Number(again(b)) - (Number(!!a.stage) * 2 + Number(again(a)))); // new stages, then building stories, first
  const chosen = fresh.slice(0, max);
  for (const s of chosen) {
    const ev = s.history?.length ? events.filter((e) => e.key === s.key && (e.people.length || e.company)).at(-1) : undefined;
    if (ev) s.attention = await publicAttention([...ev.people, ...(ev.company ? [ev.company] : [])], s.history![0].date, et.date, deps.fetchImpl);
  }
  const prompt = buildStoryPrompt(chosen, et.date, preferences);
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !triage; attempt++) {
    try {
      const reply = await deps.callModel({ model: settings.model, effort: "medium", user: attempt ? `${prompt}\n\nA previous reply could not be used (${lastError}). Reply with only the JSON object; tickers are plain US symbols.` : prompt, purpose: "stories" });
      await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "stories", usage: reply.usage, costUsd: reply.costUsd, ok: true });
      const parsed = parseStoryTriage(reply.text);
      if (parsed.dropped.length) report.error = `dropped trades with non-US tickers: ${parsed.dropped.join("; ")}`;
      triage = parsed;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "stories", usage: null, costUsd: null, ok: false });
    }
  }
  if (!triage) {
    report.error = `story triage failed twice: ${lastError}`;
    return report;
  }

  for (const t of triage.stories) {
    const story = fresh.find((s) => s.key === t.key);
    if (!story) continue;
    const stageNo = story.stage ?? (story.history?.length ? Math.max(...story.history.map((e) => e.stage)) : 1);
    await store.addStoryEvent({ etDate: et.date, key: story.key, symbols: story.symbols, stage: stageNo, summary: t.summary, escalation: story.escalation.slice(0, 10), company: t.company || null, people: t.people.slice(0, 3), labels: { novelty: t.novelty, nature: t.nature, complexity: t.complexity, staleness: story.staleness ?? null } }).catch(() => undefined);
    const termKey = story.stage ? `${story.key} (stage ${story.stage})` : story.history?.length && story.coverage?.building ? `${story.key} (building)` : story.key;
    // Public attention for a story seen for the first time, now that the desk has named its people (shown on the Stories page).
    if (!story.attention && (t.people.length || t.company)) story.attention = await publicAttention([...t.people, ...(t.company ? [t.company] : [])], story.history?.[0]?.date ?? et.date, et.date, deps.fetchImpl);
    report.triage.push({ key: t.key, summary: t.summary, skipped: t.skip ? t.skip_reason || "skipped" : null, labels: { novelty: t.novelty, nature: t.nature, complexity: t.complexity }, trades: t.trades.map((x) => ({ ticker: x.ticker, direction: x.direction, role: x.role, play: x.play, horizon_days: x.horizon_days })), attention: (story.attention ?? []).map((x) => x.line) });
    if (t.skip) {
      await store.addCandidate({ versionId: (await store.listVersions()).at(-1)?.id ?? 1, origin: "scout", term: `story: ${termKey}`, kindHint: "event", tickersHint: story.symbols, observation: null, trigger: storyTrigger(story, et.date), outcome: "rejected", reason: `story desk skipped: ${t.skip_reason}`, cardId: null }).catch(() => undefined);
      continue;
    }
    for (const trade of t.trades.slice(0, 2)) {
      const stages = (story.history?.length ? `\nEarlier stages:\n${story.history.map((e) => `- ${e.date} (stage ${e.stage}): ${e.summary}`).join("\n")}${story.stage ? `\nToday is stage ${story.stage}: ${story.escalation.slice(0, 6).join(", ")}.` : ""}` : "")
        + (story.coverage ? `\n${story.symbols[0] ?? story.key} ${story.coverage.line}.` : "")
        + (story.attention ?? []).map((x) => `\nPublic attention: ${x.line}.`).join("");
      const context = `Story: ${t.summary}${stages}\nDesk classification: ${t.novelty} news, ${t.nature}, ${t.complexity}${story.staleness !== undefined ? `; ${stalenessLabel(story.staleness)}` : ""}.\nProposed trade (${trade.role}, ${trade.play === "fade" ? "a fade: betting the move reverses" : "a follow: riding the information"}): ${trade.direction} ${trade.ticker}, horizon ${trade.horizon_days} days.\nThesis: ${trade.thesis}\nWhy the market may still misprice it: ${trade.why_not_priced}\nInvalidation: ${trade.invalidation}\nHeadlines:\n${story.headlines.map((h) => `- [${h.source}] ${h.headline}`).join("\n")}`;
      const r = await researchCandidate({ origin: "scout", term: storyTerm(termKey, trade.ticker), kindHint: "event", tickersHint: [trade.ticker], observation: null, trigger: storyTrigger(story, et.date, trade.role), context, proposedDirection: trade.direction }, deps);
      report.researched.push(r.outcome === "card" ? { term: storyTerm(termKey, trade.ticker), outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term: storyTerm(termKey, trade.ticker), outcome: r.outcome, reason: r.reason });
      if (r.outcome === "capped") report.error = r.reason; // queued; the rest are queued too
    }
  }
  return report;
}

/** Attach the desk's earlier reads of this story (last 30 days, before today); a stage number when an institution is acting today. */
export function attachHistory(s: Story, events: Array<{ etDate: string; key: string; stage: number; summary: string }>, today: string): void {
  const prior = events.filter((e) => e.key === s.key && e.etDate < today).sort((a, b) => a.etDate.localeCompare(b.etDate));
  if (!prior.length) return;
  s.history = prior.map((e) => ({ date: e.etDate, stage: e.stage, summary: e.summary }));
  if (s.escalationHits > 0) s.stage = Math.max(...prior.map((e) => e.stage)) + 1;
}

function storyTrigger(s: Story, date: string, role?: string): Signal[] {
  return [{ source: "news", metric: "story_headlines_24h", value: s.stories, baseline: null, changeVs12m: null, asOf: date, note: `${s.stories} headlines in 24h (${s.mainstream} mainstream, ${s.shockHits} with shock wording)${role ? `; ${role.replace("_", "-")} trade` : ""}`, detail: { headlines: s.headlines.slice(0, 5).map((h) => h.headline) } }];
}
