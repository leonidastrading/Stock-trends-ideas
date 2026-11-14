/**
 * Reaction-gap follow-up. The first-hours read of a story often misses the
 * trade: in the UnitedHealth case the shooting did not change the business and
 * the stock barely moved on day one; what moved it over the next weeks was what
 * the reaction revealed (public anger, then politicians with a popular target).
 *
 * Each day this pass looks again at stories the desk saw 1-10 days ago. A
 * ticker is a gap when its coverage is still loud (recent stories per day well
 * above its pre-story pace) while the stock has moved less than 5% against SPY
 * since the close before the story. Gaps go back to the story desk with the
 * three questions, framed as a follow-up; its trades are researched and gated
 * like any other card, under the term "story: <key> (follow-up) → <ticker>",
 * once per stage: a new stage (an institution acted) restarts the clock.
 *
 * "Loud" is measured from the news stream's per-ticker counts, so it sees media
 * intensity, not yet public anger on social media (Reddit once approved).
 */
import type { DailyBar } from "../alpaca";
import type { Signal } from "../sources";
import { addDays, daysBetween, toEt } from "../time";
import { preferencesText } from "./preferences";
import { researchCandidate, type ResearchDeps } from "./research";
import { parseStoryTriage, type StoryTriage } from "./stories";
import * as store from "./store";

export const FOLLOWUP = {
  minAgeDays: 1,
  maxAgeDays: 10,
  /** Quiet: the stock moved less than this against SPY since the close before the story (percent, either way). */
  maxExcessMovePct: 5,
  /** Loud: recent stories per day at least this multiple of the pre-story pace... */
  loudMultiple: 2,
  /** ...and at least this many per day. */
  loudMinStories: 4,
  maxTickersChecked: 12,
  maxGapsPerRun: 4,
};

export const followupKey = (key: string) => `${key} (follow-up)`;

export interface StorySeen { key: string; date: string; tickers: string[] }

/**
 * Pure: stories the desk saw (researched or skipped), one entry per key, from candidate terms "story: KEY",
 * "story: KEY → TICKER" and "story: KEY (stage N) → TICKER". `date` is the latest stage: a new stage restarts
 * the clock, so the quiet test is measured from it, not from the first headline. Stories already followed up
 * since their latest stage are left out.
 */
export function storiesSeen(cands: Array<{ term: string; createdAt: string; tickersHint: string[] }>, today: string): StorySeen[] {
  const by = new Map<string, StorySeen>();
  const followedUp = new Map<string, string>();
  const stagedKeys = new Set<string>();
  for (const c of cands.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const m = /^story: (.+?)(?: → (\S+))?$/.exec(c.term);
    if (!m) continue;
    const date = toEt(new Date(c.createdAt)).date;
    if (m[1].endsWith("(follow-up)")) {
      const k = m[1].replace(/ \(follow-up\)$/, "");
      if (date > (followedUp.get(k) ?? "")) followedUp.set(k, date);
      continue;
    }
    const staged = / \(stage \d+\)$/.test(m[1]);
    const key = m[1].replace(/ \(stage \d+\)$/, "");
    const s = by.get(key) ?? { key, date, tickers: [] };
    // The clock starts at the first read and moves only when a new stage arrives.
    if (staged ? date > s.date : date < s.date && !stagedKeys.has(key)) s.date = date;
    if (staged) stagedKeys.add(key);
    for (const t of [...(m[2] ? [m[2]] : []), ...c.tickersHint]) if (t && !s.tickers.includes(t.toUpperCase())) s.tickers.push(t.toUpperCase());
    by.set(key, s);
  }
  return [...by.values()].filter((s) => {
    const age = daysBetween(s.date, today);
    return age >= FOLLOWUP.minAgeDays && age <= FOLLOWUP.maxAgeDays && s.tickers.length > 0 && !((followedUp.get(s.key) ?? "") >= s.date);
  });
}

export interface Gap {
  key: string; ticker: string; storyDate: string; ageDays: number;
  /** Stories per day over the latest two days with counts after the story day. */
  recentPerDay: number | null; baselinePerDay: number | null;
  movePct: number | null; spyMovePct: number | null; excessPct: number | null;
  loud: boolean; quiet: boolean; gap: boolean; why: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: is the story still loud while the stock stays quiet? */
export function assessGap(i: {
  key: string; ticker: string; storyDate: string; today: string;
  counts: Array<{ date: string; stories: number }>; baselinePerDay: number | null;
  bars: DailyBar[]; spyBars: DailyBar[];
}): Gap {
  const after = i.counts.filter((c) => c.date > i.storyDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-2);
  const recent = after.length ? after.reduce((a, c) => a + c.stories, 0) / after.length : null;
  const need = Math.max(FOLLOWUP.loudMinStories, (i.baselinePerDay ?? 0) * FOLLOWUP.loudMultiple);
  const loud = recent !== null && recent >= need;
  const move = (bars: DailyBar[]) => {
    const s = bars.slice().sort((a, b) => a.date.localeCompare(b.date));
    const pre = s.filter((b) => b.date < i.storyDate).at(-1);
    const last = s.at(-1);
    return pre && last && last.date >= i.storyDate ? (last.c / pre.c - 1) * 100 : null;
  };
  const m = move(i.bars);
  const spy = move(i.spyBars);
  const excess = m !== null && spy !== null ? m - spy : null;
  const quiet = excess !== null && Math.abs(excess) < FOLLOWUP.maxExcessMovePct;
  const why = [
    recent === null ? "no coverage counted since the story" : `${r1(recent)} stories/day lately vs ${i.baselinePerDay === null ? "no pre-story base" : `${r1(i.baselinePerDay)}/day before`} (${loud ? "still loud" : "faded"})`,
    excess === null ? "no price since the story" : `${i.ticker} ${m! >= 0 ? "+" : ""}${r1(m!)}% vs SPY ${spy! >= 0 ? "+" : ""}${r1(spy!)}% since the close before the story (${quiet ? "quiet" : "already moved"})`,
  ].join("; ");
  return {
    key: i.key, ticker: i.ticker, storyDate: i.storyDate, ageDays: daysBetween(i.storyDate, i.today),
    recentPerDay: recent === null ? null : r1(recent), baselinePerDay: i.baselinePerDay === null ? null : r1(i.baselinePerDay),
    movePct: m === null ? null : r1(m), spyMovePct: spy === null ? null : r1(spy), excessPct: excess === null ? null : r1(excess),
    loud, quiet, gap: loud && quiet, why,
  };
}

export function buildFollowupPrompt(gaps: Array<Gap & { headlines: Array<{ at: string; source: string; headline: string }> }>, date: string, preferences: string | null = null): string {
  const L = [`Date: ${date}. Follow-up on ${gaps.length} stories the desk first saw days ago. Each stock has barely moved against SPY while the coverage stayed loud: the market's reaction may be smaller than the story's intensity. Ask the three questions; the reaction trade is the one to look for. Skip it if the story has simply run its course.`];
  if (preferences) L.push(`\n${preferences}`);
  for (const g of gaps) {
    L.push(`\n## ${followupKey(g.key)} — ${g.ticker}: first seen ${g.storyDate} (${g.ageDays} days ago). ${g.why}.`);
    for (const h of g.headlines) L.push(`- ${h.at.slice(0, 10)} [${h.source}] ${h.headline}`);
  }
  L.push("\nReply with the JSON object, one entry per story key exactly as given (including \"(follow-up)\").");
  return L.join("\n");
}

function gapTrigger(g: Gap, date: string): Signal[] {
  return [{
    source: "news", metric: `story_coverage_per_day:${g.ticker}`, value: g.recentPerDay ?? 0, baseline: g.baselinePerDay, changeVs12m: g.baselinePerDay ? Math.round(((g.recentPerDay ?? 0) / g.baselinePerDay - 1) * 100) / 100 : null, asOf: date,
    note: `Reaction gap ${g.ageDays} days after "${g.key}": ${g.why}`, detail: { excess_move_pct: g.excessPct, story_date: g.storyDate },
  }];
}

export interface FollowupReport { checked: Gap[]; researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>; skipped: Array<{ key: string; reason: string }>; error: string | null }

/** Daily: look again at recent stories, and send the loud-but-quiet ones back to the story desk. */
export async function runFollowups(deps: ResearchDeps): Promise<FollowupReport> {
  const report: FollowupReport = { checked: [], researched: [], skipped: [], error: null };
  const et = toEt(deps.now);
  if (!deps.data) return { ...report, error: "market data not configured (Alpaca keys)" };
  const settings = await store.loadSettings();
  if (!settings.enabled) return { ...report, error: "scout is switched off in Settings" };

  const seen = storiesSeen(await store.candidatesSince(40), et.date);
  const pairs = seen.flatMap((s) => s.tickers.slice(0, 3).map((ticker) => ({ s, ticker }))).slice(0, FOLLOWUP.maxTickersChecked);
  if (!pairs.length) return report;

  const tickers = [...new Set(pairs.map((p) => p.ticker))];
  const earliest = pairs.map((p) => p.s.date).sort()[0];
  let bars: DailyBar[] = [];
  try {
    bars = await deps.data.getDailyBars([...tickers, "SPY"], addDays(earliest, -10), et.date);
  } catch (err) {
    return { ...report, error: `daily bars: ${err instanceof Error ? err.message : String(err)}` };
  }
  const counts = await store.tickerCounts(tickers, addDays(earliest, -1), et.date);
  for (const { s, ticker } of pairs) {
    const base = (await store.tickerDailyAverages(addDays(s.date, -30), s.date))[ticker] ?? null;
    report.checked.push(assessGap({
      key: s.key, ticker, storyDate: s.date, today: et.date, baselinePerDay: base,
      counts: counts.filter((c) => c.symbol === ticker), bars: bars.filter((b) => b.symbol === ticker), spyBars: bars.filter((b) => b.symbol === "SPY"),
    }));
  }
  // One gap per story: the quietest ticker.
  const gaps = [...new Map(report.checked.filter((g) => g.gap).sort((a, b) => Math.abs(a.excessPct!) - Math.abs(b.excessPct!)).map((g) => [g.key, g] as const)).values()].slice(0, FOLLOWUP.maxGapsPerRun);
  if (!gaps.length) return report;

  const spend = await store.spendOn(et.date);
  if (spend.cost >= settings.dailyCapUsd) return { ...report, error: `daily LLM cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd})` };

  const withNews = [];
  for (const g of gaps) {
    const news = await deps.data.getNews([g.ticker], new Date(`${g.storyDate}T00:00:00Z`), deps.now, 40).catch(() => []);
    withNews.push({ ...g, headlines: news.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 12).map((n) => ({ at: n.ts, source: n.source, headline: n.headline })) });
  }
  const prompt = buildFollowupPrompt(withNews, et.date, preferencesText(await store.recentFeedback()));
  let triage: StoryTriage | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !triage; attempt++) {
    try {
      const reply = await deps.callModel({ model: settings.model, effort: "medium", user: attempt ? `${prompt}\n\nA previous reply could not be used (${lastError}). Reply with only the JSON object; tickers are plain US symbols.` : prompt, purpose: "stories" });
      await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "stories", usage: reply.usage, costUsd: reply.costUsd, ok: true });
      triage = parseStoryTriage(reply.text);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await store.logLlmCall({ etDate: et.date, model: settings.model, purpose: "stories", usage: null, costUsd: null, ok: false });
    }
  }
  if (!triage) return { ...report, error: `follow-up triage failed twice: ${lastError}` };

  const versionId = (await store.listVersions()).at(-1)?.id ?? 1;
  for (const g of withNews) {
    const t = triage.stories.find((x) => x.key === followupKey(g.key) || x.key === g.key);
    const fk = followupKey(g.key);
    if (!t || t.skip || !t.trades.length) {
      const reason = t ? t.skip_reason || "no trade" : "the desk did not answer for this story";
      report.skipped.push({ key: fk, reason });
      await store.addCandidate({ versionId, origin: "scout", term: `story: ${fk}`, kindHint: "event", tickersHint: [g.ticker], observation: null, trigger: gapTrigger(g, et.date), outcome: "rejected", reason: `follow-up skipped: ${reason}`, cardId: null }).catch(() => undefined);
      continue;
    }
    for (const trade of t.trades.slice(0, 2)) {
      const term = `story: ${fk} → ${trade.ticker}`;
      const context = `Follow-up on a story first seen ${g.storyDate} (${g.ageDays} days ago): ${t.summary}\nReaction gap: ${g.why}.\nProposed trade (${trade.role}): ${trade.direction} ${trade.ticker}, horizon ${trade.horizon_days} days.\nThesis: ${trade.thesis}\nWhy the market may still misprice it: ${trade.why_not_priced}\nInvalidation: ${trade.invalidation}\nHeadlines since the story:\n${g.headlines.map((h) => `- ${h.at.slice(0, 10)} [${h.source}] ${h.headline}`).join("\n")}`;
      const r = await researchCandidate({ origin: "scout", term, kindHint: "event", tickersHint: [trade.ticker], observation: null, trigger: gapTrigger(g, et.date), context }, deps);
      report.researched.push(r.outcome === "card" ? { term, outcome: `card: ${r.card.status}`, cardId: r.card.id } : { term, outcome: r.outcome, reason: r.reason });
      if (r.outcome === "capped") return { ...report, error: r.reason };
    }
  }
  return report;
}

