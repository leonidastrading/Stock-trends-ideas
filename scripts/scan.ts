/**
 * Run the daily job (scan + research) or the tracker locally against DATABASE_URL.
 *   npm run scan            daily scan
 *   npm run scan -- track   after-close tracker
 *   npm run scan -- probe "data center power"   measure one term on every source, no model call
 */
import "./env";
import { marketDataFromEnv } from "@/lib/alpaca";
import { runDaily, runTrack } from "@/lib/scout/engine";
import { allSources, probeAll } from "@/lib/sources";

const [mode, ...rest] = process.argv.slice(2);
if (mode === "track") console.log(JSON.stringify(await runTrack(), null, 2));
else if (mode === "probe") {
  const term = rest.join(" ");
  if (!term) throw new Error("probe needs a term");
  const data = marketDataFromEnv();
  const results = await probeAll(allSources(data), { term, kind: null, tickers: [], now: new Date(), env: process.env });
  for (const r of results) {
    console.log(`\n[${r.source}] ${r.status}${r.detail ? ` — ${r.detail}` : ""}`);
    for (const s of r.signals) console.log(`  ${s.note}`);
  }
} else console.log(JSON.stringify(await runDaily(), null, 2));
