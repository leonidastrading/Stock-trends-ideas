/**
 * SEC EDGAR full-text search: filings (8-K, 10-Q, 10-K) mentioning the term in
 * the last 30 days vs the monthly average over 12 months. The SEC asks every
 * automated client to identify itself: set SEC_USER_AGENT to "name contact".
 */
import { getJson } from "../http";
import { change, dateStr, daysAgo, guarded, pct, r1, type Source } from "./types";

interface Fts { hits: { total: { value: number }; hits: Array<{ _source: { display_names?: string[]; form_type?: string; file_date?: string }; _id: string }> } }

async function count(term: string, start: string, end: string, ua: string, fetchImpl?: typeof fetch): Promise<Fts> {
  const url = `https://efts.sec.gov/LatestSearch/search-index?q=${encodeURIComponent(`"${term}"`)}&forms=8-K,10-K,10-Q&dateRange=custom&startdt=${start}&enddt=${end}`;
  return getJson<Fts>(url, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, minIntervalMs: 150, fetchImpl });
}

export const edgar: Source = {
  id: "edgar",
  label: "SEC EDGAR full-text search",
  about: "New mentions of a theme in 8-K, 10-Q and 10-K filings: contracts, backlog, capacity, named customers.",
  configured: (env) => !!env.SEC_USER_AGENT,
  probe: (ctx) =>
    guarded("edgar", async () => {
      const ua = ctx.env.SEC_USER_AGENT;
      if (!ua) return { source: "edgar", status: "missing", detail: "SEC_USER_AGENT not set (the SEC requires a contact in the User-Agent)", signals: [] };
      const today = dateStr(ctx.now);
      const [m1, y1] = await Promise.all([
        count(ctx.term, dateStr(daysAgo(ctx.now, 30)), today, ua, ctx.fetchImpl),
        count(ctx.term, dateStr(daysAgo(ctx.now, 365)), today, ua, ctx.fetchImpl),
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
