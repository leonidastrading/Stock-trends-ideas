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
    // The filings desk: at most one new filing signal researched per call (three a day), if the story scan left time.
    const filings = Date.now() - started < 120_000
      ? await import("./filings").then(({ runFilingResearch }) => runFilingResearch(deps, 1)).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : "later: story scan ran long";
    const pushed = await pushNewCards(deps.env).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    // Housekeeping rides on the hourly call, in whatever time is left in the function.
    const upkeep = await maintenance(started + 240_000, deps.now, deps.fetchImpl);
    await store.finishRun(run, r.error && !r.researched.length ? "skipped" : "ok", { ...r, filings, pushed, upkeep });
    return { status: "ok" as const, ...r, filings, pushed, upkeep };
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
    const started = Date.now();
    const r = await updateTracks(data, now);
    // The day after a catalyst: read what happened and push the verdict.
    const reviews = await runReviews({ data, callModel: callResearchModel, now }).catch((err) => [{ cardId: 0, error: err instanceof Error ? err.message : String(err) }]);
    const pushed = await pushReviews(reviews as Array<{ cardId: number; verdict?: string }>).catch((err) => `push failed: ${err instanceof Error ? err.message : String(err)}`);
    // Then housekeeping in time-limited slices, so the core job always finishes inside the function's limit.
    const upkeep = await maintenance(started + 240_000, now);
    const detail = { ...r, reviews, pushedReviews: pushed, upkeep };
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
  // GitHub inbox: up to three new files per call; their ideas go to the import, which researches them separately.
  if (left() > 60_000) {
    out.inbox = await import("./inbox").then(async ({ inboxConfig, pollInbox }): Promise<unknown> => (inboxConfig() ? pollInbox({ ...defaultDeps(now), fetchImpl }, 3, fetchImpl ?? fetch) : "not configured")).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.inbox = "later: not enough time";
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
  if (left() > 20_000) {
    const { CHATTER_UNIVERSE } = await import("@/config/chatter");
    out.chatterSymbols = await refreshSymbolInfo(data, process.env, CHATTER_UNIVERSE.map((u) => u.symbol), now, 7 * 24, fetchImpl, deadline - 5_000).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  } else out.chatterSymbols = "later: not enough time";
  return out;
}
