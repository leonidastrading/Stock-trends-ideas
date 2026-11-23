/** Entry points the cron routes and scripts call. */
import { marketDataFromEnv } from "../alpaca";
import { allSources } from "../sources";
import { pushFailure, pushNewCards, pushReviews } from "./alerts";
import { callResearchModel } from "./llm";
import { runReviews } from "./review";
import { maybeSendDigest } from "./digest";
import type { ResearchDeps } from "./research";
import { runScan } from "./scan";
import { runStories } from "./stories";
import * as store from "./store";
import { updateTracks } from "./tracking";

export function defaultDeps(now = new Date()): ResearchDeps {
  const data = marketDataFromEnv();
  return { data, sources: allSources(data), callModel: callResearchModel, now, env: process.env };
}

/** The daily job: scan the watch-list, research candidates, and on Mondays send the digest. */
export async function runDaily(deps = defaultDeps()) {
  const run = await store.startRun("daily");
  try {
    const scan = await runScan(deps);
    let stories;
    try {
      stories = await runStories(deps);
    } catch (err) {
      stories = { error: err instanceof Error ? err.message : String(err) };
    }
    let followups;
    try {
      const { runFollowups } = await import("./followup");
      followups = await runFollowups(deps);
    } catch (err) {
      followups = { error: err instanceof Error ? err.message : String(err) };
    }
    let digest = "skipped";
    try {
      digest = await maybeSendDigest(deps.now, deps.env);
    } catch (err) {
      digest = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const pushed = await pushNewCards(deps.env).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    const detail = { ...scan, stories, followups, digest, pushed };
    await store.finishRun(run, scan.stoppedEarly ? "skipped" : "ok", detail);
    return { status: "ok" as const, ...detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    await pushFailure("daily", message, deps.env);
    throw err;
  }
}

/** The story desk on its own: safe to call hourly (cron-job.org or the Run now button). */
export async function runStoriesJob(deps = defaultDeps()) {
  const run = await store.startRun("stories");
  const started = Date.now();
  try {
    const r = await runStories(deps);
    console.log(`stories: ${r.headlinesRead} headlines (${r.fromStream ?? "?"} stream, ${r.fromFast ?? "?"} fast), ${r.detected.length} detected, ${r.researched.length} researched${r.nearest ? ` · ${r.nearest}` : ""}${r.error ? ` · ${r.error}` : ""}`);
    // The filings desk: at most one new filing signal researched per call (three a day), if the story scan left time.
    const filings = Date.now() - started < 120_000
      ? await import("./filings").then(({ runFilingResearch }) => runFilingResearch(deps, 1)).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : "later: story scan ran long";
    // The down-drift desk: research the freshest setup from the last scan (at most two a day), if there is time.
    const drift = Date.now() - started < 150_000 ? await driftResearch(deps) : "later: story scan ran long";
    const pushed = await pushNewCards(deps.env).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    // Housekeeping rides on the hourly call, in whatever time is left in the function.
    const upkeep = await maintenance(started + 240_000, deps.now, deps.fetchImpl);
    await store.finishRun(run, r.error && !r.researched.length ? "skipped" : "ok", { ...r, filings, drift, pushed, upkeep });
    return { status: "ok" as const, ...r, filings, drift, pushed, upkeep };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    throw err;
  }
}

/** One down-drift setup from the last hourly scan to research (never fails the job it rides on). */
async function driftResearch(deps: ResearchDeps): Promise<unknown> {
  try {
    const { runDriftResearch } = await import("./drift");
    const c = await store.cacheGet<{ setups: import("./drift").DriftSetup[] }>("drift");
    return c?.data?.setups?.length ? await runDriftResearch(deps, c.data.setups, 1) : "no setups yet";
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Import ideas from the daily stream file; recorded in Recent runs. */
export async function runImportJob(items: import("./importer").ImportItem[], label: string, deps = defaultDeps(), from?: { label: string; url?: string | null }) {
  const { runImport } = await import("./importer");
  const run = await store.startRun("import");
  try {
    const results = await runImport(items, deps, label, 3, from);
    await store.finishRun(run, "ok", { label, results });
    return { status: "ok" as const, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", { label }, message);
    throw err;
  }
}

/** The after-close job: ingest daily bars and move every paper track forward. */
export async function runTrack(now = new Date()) {
  const run = await store.startRun("track");
  try {
    const data = marketDataFromEnv();
    if (!data) {
      await store.finishRun(run, "skipped", { reason: "ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set" });
      return { status: "skipped" as const, reason: "Alpaca keys not set" };
    }
    const started = Date.now();
    const r = await updateTracks(data, now);
    // The day after a catalyst: read what happened and push the verdict.
    const reviews = await runReviews({ data, callModel: callResearchModel, now }).catch((err) => [{ cardId: 0, error: err instanceof Error ? err.message : String(err) }]);
    const pushed = await pushReviews(reviews as Array<{ cardId: number; verdict?: string }>).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    // The earnings-drift desk: tonight's reports through the numbers, exits moved to known report dates, paper tracks, cards.
    const earnings = await earningsNight(data, now, started + 200_000);
    // Then housekeeping in time-limited slices, so the core job always finishes inside the function's limit.
    const upkeep = await maintenance(started + 240_000, now);
    const detail = { ...r, reviews, pushedReviews: pushed, earnings, upkeep };
    await store.finishRun(run, "ok", detail);
    return { status: "ok" as const, ...detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    await pushFailure("tracker", message);
    throw err;
  }
}

/** The earnings desk's nightly steps (never fails the job it rides on). */
export async function earningsNight(data: import("../alpaca").MarketData, now: Date, deadline: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const e = await import("./earnings");
    out.scan = await e.scanEarnings(data, now).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    // Tomorrow's reports: freeze consensus, market cap and year-ago EPS while they are still before release.
    out.snapshots = await e.snapshotConsensus(data, now).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    out.docs = await e.gatherSetupDocs({ data, env: process.env, now }, deadline).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    out.exits = await e.refreshExits(data, now).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    out.tracks = await e.updateEarningsTracks(data, now).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    out.cards = await e.writeCards({ data, callModel: callResearchModel, now, env: process.env }, deadline).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** Bars for the look-back pass start here (the exploratory Stocktwits history covers the 3 months before the test began). */
export const CHATTER_EXPLORE_FROM = "2026-07-20";

/** One batch of the chatter test; never fails the job it rides on. */
export async function chatterBatch(now = new Date(), fetchImpl?: typeof fetch) {
  try {
    const { runChatterBatch } = await import("./chatter");
    return await runChatterBatch(now, fetchImpl);
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Housekeeping in slices, each only if there is time before `deadline`:
 * names and earnings for card symbols (daily), a chatter-test batch, the
 * chatter test's bars, and names / earnings dates for its 198 stocks (weekly).
 * Whatever is left is picked up by the next call (hourly story call, after-close job).
 */
export async function maintenance(deadline: number, now = new Date(), fetchImpl?: typeof fetch) {
  const left = () => deadline - Date.now();
  const out: Record<string, unknown> = {};
  const data = marketDataFromEnv();
  const { refreshSymbolInfo } = await import("./symbols");
  try {
    const symbols = await store.cardsSince(120).then((cs) => [...new Set(cs.flatMap((c) => c.card.tickers.map((t) => t.symbol)))]);
    out.cardSymbols = await refreshSymbolInfo(data, process.env, symbols, now, 20, fetchImpl, deadline - 5_000);
  } catch (err) {
    out.cardSymbols = `failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  out.chatter = left() > 100_000 ? await chatterBatch(now, fetchImpl) : "later: not enough time";
  if (data && left() > 40_000) {
    out.chatterBars = await import("./chatter").then(({ ensureChatterBars }) => ensureChatterBars(data, now, CHATTER_EXPLORE_FROM)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.chatterBars = "later: not enough time";
  // GitHub inbox: every new file (until near the deadline); their ideas go to the import, which researches them separately.
  if (left() > 60_000) {
    out.inbox = await import("./inbox").then(async ({ inboxConfig, pollInbox }): Promise<unknown> => (inboxConfig() ? pollInbox({ ...defaultDeps(now), fetchImpl }, 50, fetchImpl ?? fetch, undefined, deadline - 50_000) : "not configured")).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.inbox = "later: not enough time";
  // Dashboard: a year of bars for the breadth universe (once, then incremental), and the panel caches kept warm.
  if (data && left() > 45_000) {
    out.breadthBars = await import("../market/panels").then(({ ensureBreadthBars }) => ensureBreadthBars(data, now)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.breadthBars = "later: not enough time";
  if (left() > 30_000) {
    out.panels = await import("./dashboard-warm").then(({ warmPanels }) => warmPanels(now)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The stock list behind the search box's suggestions (refreshed daily).
  if (data && left() > 40_000) out.assets = await import("./symbol-search").then(async ({ listings }) => `${(await listings()).length} listings`).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  // Schwab's weekly sign-in: a phone alert once, the day before it lapses.
  out.schwab = await import("../sources/schwab").then(async ({ schwabStatus }) => {
    const s = await schwabStatus(process.env, now);
    if (!s.connected || s.hoursLeft === null) return s.configured ? "not connected" : "not set up";
    if (s.hoursLeft <= 24 && (await store.tryLock(`schwab:reminded:${s.expiresAt}`, 60 * 24 * 8))) {
      const { pushConfigured, sendPush } = await import("../notify");
      if (pushConfigured()) await sendPush({ title: "Schwab sign-in expires soon", message: s.mode === "shared" ? `The Schwab login shared with oo-trading lapses in about ${s.hoursLeft} hours. Sign in again in oo-trading.` : `Short interest stops in about ${s.hoursLeft} hours. Settings → Sign in again (renews 7 days).`, click: `${(process.env.DASHBOARD_URL ?? "").replace(/\/$/, "")}/settings#schwab`, tags: ["key"], priority: 4 });
      return `reminder sent (${s.hoursLeft}h left)`;
    }
    return `connected, ${s.hoursLeft}h left`;
  }).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  // Earnings desk: fill the year of surprise history (a few days per call) and write any cards still waiting.
  if (data && left() > 60_000) {
    out.earnings = await import("./earnings").then(async (e) => ({
      // Consensus snapshots for the next sessions' reports, hourly too (a report's snapshot is the latest one before its release).
      snapshots: await e.snapshotConsensus(data, now, fetchImpl).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`),
      history: await e.backfillHistory(data, now, Math.min(deadline - 40_000, Date.now() + 60_000), fetchImpl),
      cards: left() > 90_000 ? await e.writeCards({ data, callModel: callResearchModel, now, env: process.env, fetchImpl }, deadline - 30_000, 2) : "later",
    })).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.earnings = "later: not enough time";
  // Down drift: stocks still falling after bad news (bars for ~700 stocks, headlines for the few that qualify), hourly.
  if (data && left() > 70_000) {
    out.drift = await Promise.all([import("./drift"), import("../market/panels")]).then(async ([{ scanDrift }, { panel }]) => {
      const p = await panel("drift", 55, () => scanDrift(data, now), 60_000);
      return p.error ? `failed: ${p.error}` : `${p.data?.setups.length ?? 0} setups from ${p.data?.scanned ?? 0} stocks`;
    }).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.drift = "later: not enough time";
  // Options positioning: each stock's option chain once per trading day (10:00-16:00 ET), up to a minute and a half per call.
  if (left() > 60_000) {
    out.options = await import("./options-flow").then(({ runOptionsLog }) => runOptionsLog(Math.min(deadline - 45_000, Date.now() + 90_000), now, fetchImpl)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.options = "later: not enough time";
  // Watch-list: the scout's proposals go live and its quiet terms retire (when auto-approve is on).
  if ((await store.loadSettings()).autoApproveTerms !== false) out.watchlist = await store.watchlistUpkeep().catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  // Trump's posts (fallback for when the five-minute /api/cron/truth call is not set up).
  if (left() > 70_000 && (await store.tryLock("lock:truth", 5))) {
    out.truth = await import("./truth").then(({ pollTruth }) => pollTruth({ ...defaultDeps(now), fetchImpl }, fetchImpl, { research: left() > 200_000 })).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    await store.unlock("lock:truth").catch(() => undefined);
  }
  // Your websites: each read once a day; new articles' ideas go to the import, which researches them in its own function.
  if (left() > 60_000) {
    out.sites = await Promise.all([import("./sites"), import("./inbox")]).then(([{ checkSites }, { sendToImport }]) => checkSites({ ...defaultDeps(now), fetchImpl }, deadline - 30_000, sendToImport(process.env, fetchImpl ?? fetch), fetchImpl)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.sites = "later: not enough time";
  // Rumors: new files in the inbox repo's rumors/ folder (read for market-relevant claims; nothing researched).
  if (left() > 90_000) {
    out.rumors = await import("./rumors").then(({ pollRumors }) => pollRumors({ ...defaultDeps(now), fetchImpl }, 2, fetchImpl ?? fetch, deadline - 30_000)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.rumors = "later: not enough time";
  // Themes: the top 3 ideas the sources agree on, once a weekday from 7 AM ET.
  if (left() > 90_000) {
    out.themes = await import("./themes").then(({ themesIfDue }) => themesIfDue({ data, callModel: callResearchModel, now, fetchImpl })).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.themes = "later: not enough time";
  // Positioning: the CFTC report (read twice a day; it changes Fridays) and dealer gamma for the index ETFs (every 6 hours).
  if (left() > 60_000) {
    out.positioning = await import("../market/positioning").then(async ({ cotReadings, gammaFor }) => {
      const { panel } = await import("../market/panels");
      const cot = await panel("cot", 12 * 60, () => cotReadings(now, fetchImpl), 25_000);
      const g = await Promise.all(["SPY", "QQQ", "IWM"].map((s) => gammaFor(s, now, fetchImpl).catch(() => null)));
      return `COT ${cot.data ? `${(cot.data as unknown[]).length} markets` : `failed: ${cot.error}`}; gamma ${g.filter(Boolean).length}/3`;
    }).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.positioning = "later: not enough time";
  // Dots: second-order ideas from what is changing in the world, once a weekday from 8 AM ET (two AI calls, ~40 searches).
  if (left() > 150_000) {
    out.dots = await import("./dots").then(({ dotsIfDue }) => dotsIfDue({ data, callModel: callResearchModel, now, fetchImpl })).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.dots = "later: not enough time";
  // Pharma: the FDA calendar (twice a day) and Phase 3 readouts (daily), kept warm for the Pharma page.
  if (left() > 60_000) {
    out.pharma = await Promise.all([import("../sources/pharma"), import("../market/panels"), import("../sources/edgar")]).then(async ([ph, { panel }, { secTickerList }]) => {
      const today = (await import("../time")).toEt(now).date;
      const ua = process.env.SEC_USER_AGENT?.trim();
      const fda = await panel("pharma:fda", 12 * 60, () => ph.fetchFdaCalendar(today, fetchImpl), 25_000);
      const tr = ua ? await panel("pharma:trials", 24 * 60, async () => ph.fetchTrialReadouts(today, await secTickerList(ua, fetchImpl), fetchImpl), 25_000) : null;
      return `FDA ${fda.data ? `${(fda.data as unknown[]).length} events` : `failed: ${fda.error}`}; trials ${tr?.data ? `${(tr.data as unknown[]).length}` : tr ? `failed: ${tr.error}` : "no SEC_USER_AGENT"}`;
    }).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.pharma = "later: not enough time";
  // Open cards: is any card's own invalidation met? (about every 3 hours each, on the live price and headlines)
  if (left() > 70_000) {
    out.invalidation = await import("./invalidation").then(({ checkInvalidations }) => checkInvalidations({ data, callModel: callResearchModel, now, env: process.env }, deadline - 30_000)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.invalidation = "later: not enough time";
  // Market cap and short interest per card, frozen the day it is written (for scoring by size and short interest).
  if (left() > 60_000) {
    out.cardProfiles = await import("./card-profiles").then(({ captureCardProfiles }) => captureCardProfiles(now, deadline - 40_000)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.cardProfiles = "later: not enough time";
  // Rumors that came true: each rumor from the last 30 days is checked again about once a day.
  if (left() > 80_000) {
    out.rumorChecks = await import("./rumor-check").then(({ checkRumors }) => checkRumors({ data, callModel: callResearchModel, now, fetchImpl, env: process.env }, deadline - 30_000)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.rumorChecks = "later: not enough time";
  // Congress trades: new House transaction reports (at most a minute per call), then their buys priced against SPY.
  if (left() > 60_000) {
    try {
      const { pollHouse, pollSenate } = await import("./congress");
      out.congress = await pollHouse(Math.min(deadline - 45_000, Date.now() + 45_000), now, fetchImpl ?? fetch);
      out.senate = await pollSenate(Math.min(deadline - 45_000, Date.now() + 30_000), now, fetchImpl ?? fetch).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
      if (data && left() > 35_000) {
        const [{ congressPerformance }, { panel }] = await Promise.all([import("./congress"), import("../market/panels")]);
        const p = await panel("congress-perf", 0, () => congressPerformance(data, now), 20_000);
        out.congressPerf = p.error ? `failed: ${p.error}` : `${p.data?.length ?? 0} buys priced`;
      }
    } catch (err) {
      out.congress = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else out.congress = "later: not enough time";
  // SEC filings: read any new daily index into the queue, then work through the queue.
  const ua = process.env.SEC_USER_AGENT?.trim();
  if (!ua) out.filings = "skipped: SEC_USER_AGENT not set";
  else if (left() > 30_000) {
    try {
      const { loadIndexes, processQueue } = await import("./filings");
      const idx = await loadIndexes(now, ua, fetchImpl);
      out.filings = { ...idx, ...(await processQueue(deadline - 25_000, ua, fetchImpl)) };
    } catch (err) {
      out.filings = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else out.filings = "later: not enough time";
  // Filing watch on card stocks: late 10-Q/10-K, late-filing notices, restatements and auditor changes (every 6 hours each).
  if (ua && left() > 25_000) {
    out.filingWatch = await import("./filing-watch").then(({ runFilingWatch }) => runFilingWatch({ now, ua, env: process.env, fetchImpl }, deadline - 20_000)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (left() > 20_000) {
    const { CHATTER_UNIVERSE } = await import("@/config/chatter");
    out.chatterSymbols = await refreshSymbolInfo(data, process.env, CHATTER_UNIVERSE.map((u) => u.symbol), now, 7 * 24, fetchImpl, deadline - 5_000).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.chatterSymbols = "later: not enough time";
  return out;
}
