/** Entry points the cron routes and scripts call. */
import { marketDataFromEnv } from "../alpaca";
import { allSources } from "../sources";
import { callResearchModel } from "./llm";
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
    let digest = "skipped";
    try {
      digest = await maybeSendDigest(deps.now, deps.env);
    } catch (err) {
      digest = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const detail = { ...scan, stories, digest };
    await store.finishRun(run, scan.stoppedEarly ? "skipped" : "ok", detail);
    return { status: "ok" as const, ...detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    throw err;
  }
}

/** The story desk on its own: safe to call hourly (cron-job.org or the Run now button). */
export async function runStoriesJob(deps = defaultDeps()) {
  const run = await store.startRun("stories");
  try {
    const r = await runStories(deps);
    await store.finishRun(run, r.error && !r.researched.length ? "skipped" : "ok", r);
    return { status: "ok" as const, ...r };
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
    await store.finishRun(run, "ok", r);
    return { status: "ok" as const, ...r };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.finishRun(run, "error", null, message);
    throw err;
  }
}
