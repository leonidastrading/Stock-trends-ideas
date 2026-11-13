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
import { preferencesText } from "./preferences";
import { researchCandidate, type ResearchDeps } from "./research";
import * as store from "./store";

// ------------------------------------------------------------- detection

/** Wording that marks a shock rather than ordinary coverage. */
export const SHOCK = /\b(shot|killed|dies|death|assassinat\w*|resign\w*|steps? down|ousted?|fired|scandal|affair|indict\w*|arrest\w*|charged|fraud|probe|investigat\w*|subpoena|lawsuit|sued|verdict|ruling|antitrust|ban(?:s|ned)?|block(?:s|ed)|tariffs?|sanction\w*|executive order|regulat\w*|legislation|bill passes|war|strikes?|missile|ceasefire|invasion|blockade|outage|hack(?:ed)?|breach|recall|halt(?:s|ed)?|bankrupt\w*|chapter 11|default|downgrade|pivot\w*|guidance cut|cuts? (?:guidance|outlook|forecast)|FDA (?:approv|reject|warn)\w*|short report|short seller)\b/i;

export interface Story {
  /** Stable key for the day: the ticker, or the shock word for macro stories. */
  key: string;
  label: string;
  symbols: string[];
  stories: number;
  mainstream: number;
  shockHits: number;
  headlines: Array<{ at: string; headline: string; source: string; symbols: string[] }>;
}

export interface DetectOptions {
  /** Trailing daily average of stories per ticker, when known (from stored history). */
  dailyAvg?: Record<string, number>;
  minMainstream?: number;
  minStories?: number;
  spikeMultiple?: number;
  maxStories?: number;
}

/** Pure: find the day's stories. Ticker stories need mainstream coverage and shock wording or a spike; macro stories are shock wording across many headlines with few tickers. */
export function detectStories(items: NewsItem[], opts: DetectOptions = {}): Story[] {
  const { dailyAvg = {}, minMainstream = 3, minStories = 6, spikeMultiple = 4, maxStories = 8 } = opts;
  const byTicker = new Map<string, Story>();
  const macro = new Map<string, Story>();
  for (const n of items) {
    const text = `${n.headline} ${n.summary}`;
    const shock = SHOCK.exec(text)?.[1]?.toLowerCase() ?? null;
    const main = isMainstream(n);
    const h = { at: n.ts.slice(0, 10), headline: n.headline, source: n.source, symbols: n.symbols };
    if (n.symbols.length > 0 && n.symbols.length <= 6) {
      for (const s of n.symbols) {
        const t = byTicker.get(s) ?? { key: s, label: s, symbols: [s], stories: 0, mainstream: 0, shockHits: 0, headlines: [] };
        t.stories++;
        if (main) t.mainstream++;
        if (shock) t.shockHits++;
        if (t.headlines.length < 8 && (shock || main)) t.headlines.push(h);
        byTicker.set(s, t);
      }
    } else if (shock && n.symbols.length === 0) {
      const m = macro.get(shock) ?? { key: `macro:${shock}`, label: shock, symbols: [], stories: 0, mainstream: 0, shockHits: 0, headlines: [] };
      m.stories++;
      m.shockHits++;
      if (main) m.mainstream++;
      if (m.headlines.length < 8) m.headlines.push(h);
      macro.set(shock, m);
    }
  }
  const out: Story[] = [];
  for (const t of byTicker.values()) {
    const avg = dailyAvg[t.key];
    const spike = avg ? t.stories >= spikeMultiple * avg : false;
    if (t.mainstream >= minMainstream && (t.shockHits >= 2 || spike || t.stories >= minStories * 2)) out.push(t);
  }
  for (const m of macro.values()) if (m.stories >= minStories && m.mainstream >= minMainstream) out.push(m);
  return out.sort((a, b) => b.shockHits * 3 + b.mainstream - (a.shockHits * 3 + a.mainstream)).slice(0, maxStories);
}

// ---------------------------------------------------------------- triage

export const STORY_SYSTEM_PROMPT = `You are the story desk of a paper-only "trend scout". You are shown the day's breaking stories from a market news stream: shocks such as a CEO scandal or death, a war or ceasefire, a ban, tariff or sanction, a regulator's move, an indictment, a recall, a strategic pivot, a guidance cut. For each story you lay out the trades it implies, the way an event-driven trader would in the first hours:

- The direct trade: the named company or the obvious fund (an oil fund on a war, a defense name on an attack), with direction.
- The second-order trade: who wins or loses one step away that the headlines are not about yet (a rival that takes share, a supplier, a customer, a platform that loses traffic to the thing in the news).
- For each, how long the repricing should take (days to weeks), what would prove it wrong, and why the market may still be mispricing it after the first move: forced sellers, a slow-burning investigation, an index or fund flow, a second shoe to drop.

Rules: at most two trades per story, the second-order one preferred when it is credible. Skip stories that are noise, already fully played out, or have no listed exposure, and say why. Shares only; never options. Be concrete and short.`;

export const storyTriageSchema = z.object({
  stories: z.array(z.object({
    key: z.string().min(1),
    summary: z.string().min(1).max(400),
    skip: z.boolean(),
    skip_reason: z.string().max(300),
    trades: z.array(z.object({
      ticker: z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}(\.[A-Z])?$/),
      direction: z.enum(["long", "short"]),
      role: z.enum(["direct", "second_order"]),
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
        type: "object", additionalProperties: false, required: ["key", "summary", "skip", "skip_reason", "trades"],
        properties: {
          key: { type: "string", description: "the story key exactly as given" },
          summary: { type: "string", description: "what happened, one or two sentences" },
          skip: { type: "boolean" },
          skip_reason: { type: "string", description: "empty when not skipped" },
          trades: {
            type: "array", description: "at most two; empty when skipped",
            items: {
              type: "object", additionalProperties: false, required: ["ticker", "direction", "role", "horizon_days", "thesis", "why_not_priced", "invalidation"],
              properties: {
                ticker: { type: "string" }, direction: { type: "string", enum: ["long", "short"] }, role: { type: "string", enum: ["direct", "second_order"] },
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
    L.push(`\n## ${s.key} — ${s.symbols.length ? s.symbols.join(", ") : "macro"}: ${s.stories} headlines, ${s.mainstream} mainstream, ${s.shockHits} with shock wording`);
    for (const h of s.headlines) L.push(`- [${h.source}${h.symbols.length ? ` · ${h.symbols.join(",")}` : ""}] ${h.headline}`);
  }
  L.push("\nReply with the JSON object, one entry per story key.");
  return L.join("\n");
}

export function parseStoryTriage(text: string): StoryTriage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("story reply is not valid JSON");
  }
  const r = storyTriageSchema.safeParse(raw);
  if (!r.success) throw new Error(`story reply failed validation: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

// ------------------------------------------------------------------- run

export const STORY_COOLDOWN_DAYS = 3;
export const storyTerm = (key: string, ticker: string) => `story: ${key} → ${ticker}`;

export interface StoriesReport {
  date: string;
  headlinesRead: number;
  detected: Array<{ key: string; symbols: string[]; stories: number; mainstream: number; shockHits: number; sample: string[] }>;
  triage: Array<{ key: string; summary: string; skipped: string | null; trades: Array<{ ticker: string; direction: string; role: string; horizon_days: number }> }>;
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
  } catch (err) {
    report.error = `news stream: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }
  report.headlinesRead = items.length;
  const dailyAvg = await store.tickerDailyAverages(addDays(et.date, -30), et.date);
  const stories = detectStories(items, { dailyAvg });
  report.detected = stories.map((s) => ({ key: s.key, symbols: s.symbols, stories: s.stories, mainstream: s.mainstream, shockHits: s.shockHits, sample: s.headlines.slice(0, 3).map((h) => h.headline) }));
  await store.saveTickerCounts(et.date, items);
  if (!stories.length) return report;

  const recent = await store.recentTerms(STORY_COOLDOWN_DAYS);
  const fresh = stories.filter((s) => ![...recent].some((t) => t.startsWith(`story: ${s.key.toLowerCase()} `)));
  if (!fresh.length) {
    report.error = `all ${stories.length} stories were researched in the last ${STORY_COOLDOWN_DAYS} days`;
    return report;
  }
  const spend = await store.spendOn(et.date);
  if (spend.cost >= settings.dailyCapUsd) {
    report.error = `daily LLM cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd})`;
    return report;
  }

  let triage: StoryTriage;
  try {
    const preferences = preferencesText(await store.recentFeedback());
    const reply = await deps.callModel({ model: settings.model, effort: "medium", user: buildStoryPrompt(fresh.slice(0, max), et.date, preferences), purpose: "stories" });
    await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "stories", usage: reply.usage, costUsd: reply.costUsd, ok: true });
    triage = parseStoryTriage(reply.text);
  } catch (err) {
    await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "stories", usage: null, costUsd: null, ok: false });
    report.error = `story triage failed: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }

  for (const t of triage.stories) {
    const story = fresh.find((s) => s.key === t.key);
    if (!story) continue;
    report.triage.push({ key: t.key, summary: t.summary, skipped: t.skip ? t.skip_reason || "skipped" : null, trades: t.trades.map((x) => ({ ticker: x.ticker, direction: x.direction, role: x.role, horizon_days: x.horizon_days })) });
    if (t.skip) {
      await store.addCandidate({ versionId: (await store.listVersions()).at(-1)?.id ?? 1, origin: "scout", term: `story: ${story.key}`, kindHint: "event", tickersHint: story.symbols, observation: null, trigger: storyTrigger(story, et.date), outcome: "rejected", reason: `story desk skipped: ${t.skip_reason}`, cardId: null }).catch(() => undefined);
      continue;
    }
    for (const trade of t.trades.slice(0, 2)) {
      const context = `Story: ${t.summary}\nProposed trade (${trade.role}): ${trade.direction} ${trade.ticker}, horizon ${trade.horizon_days} days.\nThesis: ${trade.thesis}\nWhy the market may still misprice it: ${trade.why_not_priced}\nInvalidation: ${trade.invalidation}\nHeadlines:\n${story.headlines.map((h) => `- [${h.source}] ${h.headline}`).join("\n")}`;
      const r = await researchCandidate({ origin: "scout", term: storyTerm(story.key, trade.ticker), kindHint: "event", tickersHint: [trade.ticker], observation: null, trigger: storyTrigger(story, et.date, trade.role), context }, deps);
      report.researched.push(r.outcome === "card" ? { term: storyTerm(story.key, trade.ticker), outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term: storyTerm(story.key, trade.ticker), outcome: r.outcome, reason: r.reason });
      if (r.outcome === "capped") {
        report.error = r.reason;
        return report;
      }
    }
  }
  return report;
}

function storyTrigger(s: Story, date: string, role?: string): Signal[] {
  return [{ source: "news", metric: "story_headlines_24h", value: s.stories, baseline: null, changeVs12m: null, asOf: date, note: `${s.stories} headlines in 24h (${s.mainstream} mainstream, ${s.shockHits} with shock wording)${role ? `; ${role.replace("_", "-")} trade` : ""}`, detail: { headlines: s.headlines.slice(0, 5).map((h) => h.headline) } }];
}
