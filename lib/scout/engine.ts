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
    const pushed = await pushNewCards(deps.env).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    // The chatter test rides on the hourly call: the next batch of symbols, if there is time left in the function.
    const chatter = Date.now() - started < 150_000 ? await chatterBatch(deps.now, deps.fetchImpl) : "skipped: story scan ran long";
    await store.finishRun(run, r.error && !r.researched.length ? "skipped" : "ok", { ...r, pushed, chatter });
    return { status: "ok" as const, ...r, pushed, chatter };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    throw err;
  }
}

/** Import ideas from the daily stream file; recorded in Recent runs. */
export async function runImportJob(items: import("./importer").ImportItem[], label: string, deps = defaultDeps()) {
  const { runImport } = await import("./importer");
  const run = await store.startRun("import");
  try {
    const results = await runImport(items, deps, label);
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
    const r = await updateTracks(data, now);
    const chatter = await chatterBatch(now);
    // Bars for the chatter test's 198 stocks, SPY and the sector funds, from the start of the look-back window.
    const chatterBars = await import("./chatter").then(({ ensureChatterBars }) => ensureChatterBars(data, now, CHATTER_EXPLORE_FROM)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    const earnings = await import("./chatter").then(({ refreshEarningsDates }) => refreshEarningsDates(process.env, CHATTER_EXPLORE_FROM)).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
    // The day after a catalyst: read what happened and push the verdict.
    const reviews = await runReviews({ data, callModel: callResearchModel, now }).catch((err) => [{ cardId: 0, error: err instanceof Error ? err.message : String(err) }]);
    const pushed = await pushReviews(reviews as Array<{ cardId: number; verdict?: string }>).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    const detail = { ...r, reviews, pushedReviews: pushed, chatter, chatterBars, earnings };
    await store.finishRun(run, "ok", detail);
    return { status: "ok" as const, ...detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    await pushFailure("tracker", message);
    throw err;
  }
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
