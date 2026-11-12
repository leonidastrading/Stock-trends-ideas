/**
 * SEC EDGAR full-text search: filings (8-K, 10-Q, 10-K) mentioning the term in
 * the last 30 days vs the monthly average over 12 months. The SEC asks every
 * automated client to identify itself: set SEC_USER_AGENT to "name contact".
 *
 * efts.sec.gov refuses Vercel's addresses, so when EDGAR_PROXY_URL /
 * EDGAR_PROXY_TOKEN are set the search goes through the relay in relay/
 * (deployed on a network the SEC accepts), which adds the User-Agent itself.
 */
import { getJson, HttpError } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Source } from "./types";

interface Fts { hits: { total: { value: number }; hits: Array<{ _source: { display_names?: string[]; form_type?: string; file_date?: string }; _id: string }> } }

interface Route { url: (target: string) => string; headers: Record<string, string>; viaRelay: boolean }

/** Direct with the declared User-Agent, or through the relay when configured. */
export function route(env: NodeJS.ProcessEnv): Route | null {
  const relay = env.EDGAR_PROXY_URL?.replace(/\/$/, "");
  if (relay && env.EDGAR_PROXY_TOKEN) return { url: (t) => `${relay}/fetch?url=${encodeURIComponent(t)}`, headers: { authorization: `Bearer ${env.EDGAR_PROXY_TOKEN}` }, viaRelay: true };
  if (env.SEC_USER_AGENT) return { url: (t) => t, headers: { "user-agent": env.SEC_USER_AGENT, "accept-encoding": "gzip, deflate" }, viaRelay: false };
  return null;
}

async function count(term: string, start: string, end: string, r: Route, fetchImpl?: typeof fetch): Promise<Fts> {
  const target = `https://efts.sec.gov/LatestSearch/search-index?q=${encodeURIComponent(`"${term}"`)}&forms=8-K,10-K,10-Q&dateRange=custom&startdt=${start}&enddt=${end}`;
  try {
    return await getJson<Fts>(r.url(target), { headers: r.headers, minIntervalMs: 150, fetchImpl });
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) throw new Error(r.viaRelay ? "efts.sec.gov refused the relay's address too (403); move the relay to another network" : "efts.sec.gov refuses requests from this server's address (403 whatever the User-Agent); set EDGAR_PROXY_URL / EDGAR_PROXY_TOKEN to the relay in relay/");
    throw err;
  }
}

export const edgar: Source = {
  id: "edgar",
  label: "SEC EDGAR full-text search",
  about: "New mentions of a theme in 8-K, 10-Q and 10-K filings: contracts, backlog, capacity, named customers.",
  configured: (env) => route(env) !== null,
  probe: (ctx) =>
    guarded("edgar", async () => {
      const r = route(ctx.env);
      if (!r) return { source: "edgar", status: "missing", detail: "SEC_USER_AGENT not set (the SEC requires a contact in the User-Agent), or EDGAR_PROXY_URL / EDGAR_PROXY_TOKEN for the relay", signals: [] };
      const today = dateStr(ctx.now);
      const [m1, y1] = await Promise.all([
        count(ctx.term, dateStr(daysAgo(ctx.now, 30)), today, r, ctx.fetchImpl),
        count(ctx.term, dateStr(daysAgo(ctx.now, 365)), today, r, ctx.fetchImpl),
      ]);
      const monthly12 = r1(y1.hits.total.value / 12);
      const ch = change(m1.hits.total.value, monthly12);
      const filers = m1.hits.hits.slice(0, 8).map((h) => ({ filer: h._source.display_names?.[0] ?? "?", form: h._source.form_type, date: h._source.file_date }));
      return {
        source: "edgar", status: "ok", signals: [{
          source: "edgar", metric: "filings_30d", value: m1.hits.total.value, baseline: monthly12, changeVs12m: ch, asOf: today,
          note: `${m1.hits.total.value} filings (8-K/10-Q/10-K) mention "${ctx.term}" in 30 days vs ${monthly12}/month over 12 months (${pct(ch)})`,
          detail: { recent_filers: filers },
        }],
      };
    }),
};
