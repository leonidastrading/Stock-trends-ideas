import CardChips from "@/components/CardChips";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { CHECK_ABOUT, CHECK_LABEL, LONG_TERM, longTermRows, longTermUniverse, priceOf, type Check, type CheckId, type LongTermRow } from "@/lib/scout/long-term";
import * as store from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Rows shown in the longer lists (the fair-price list is shown whole). */
const SHOW = 150;
const ORDER: CheckId[] = ["returns", "profitable", "growth", "debt", "cash", "margin", "dilution"];
const num = (x: number | null | undefined, suffix = "") => (x === null || x === undefined ? "—" : `${x}${suffix}`);
const sectorName = (s: string | null) => (s ?? "").replace(/_/g, " ");

function Ticks({ checks }: { checks: Check[] }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {ORDER.map((id) => {
        const c = checks.find((x) => x.id === id);
        const mark = !c || c.pass === null ? "–" : c.pass ? "✓" : "✗";
        return <span key={id} className={!c || c.pass === null ? "muted" : c.pass ? "pos" : "neg"} title={`${CHECK_LABEL[id]}: ${c?.detail ?? "not checked"}`} style={{ display: "inline-block", width: 16, textAlign: "center", cursor: "help", fontWeight: 700 }}>{mark}</span>;
      })}
    </span>
  );
}

type Priced = { r: LongTermRow; p: ReturnType<typeof priceOf>; price: number | null };

function Table({ rows, cardsOn, showMiss = false }: { rows: Priced[]; cardsOn: (s: string) => store.CardBrief[]; showMiss?: boolean }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr>
        <th>Stock</th><th title="In order: return on owners' money, profit every year, earnings grew, little debt, profits arrive as cash, share of sales kept, no watering down. Hover a mark for the figure.">Checks</th>
        {showMiss && <th>Missed</th>}
        <th className="num" title="Net income as a share of shareholders' equity, averaged over the years on file">Return on equity</th>
        <th className="num" title="Yearly growth of net income over the years on file">Profit growth</th>
        <th className="num" title="Long-term debt divided by last year's net income">Debt, years of profit</th>
        <th className="num" title="Net income as a share of sales, averaged">Margin</th>
        <th className="num" title="Change in the share count over five years, stock splits taken out. Below zero means the company bought its own shares back.">Shares, 5 years</th>
        <th className="num" title="Market value divided by last fiscal year's net income">Price ÷ earnings</th>
        <th className="num" title="Last year's profit, and its cash from operations less capital spending, as a share of today's market value">Earnings · free-cash yield</th>
        <th>Scout cards</th>
      </tr></thead>
      <tbody>{rows.map(({ r, p }) => {
        const m = r.metrics!;
        const miss = r.checks.filter((c) => c.pass === false);
        return (
          <tr key={r.symbol}>
            <td><Ticker symbol={r.symbol} /> <div className="small muted">{[r.name, sectorName(r.sector) || null, r.rank ? `#${r.rank} by size` : null, `${m.years} years to ${m.lastYear.slice(0, 4)}`].filter(Boolean).join(" · ")}</div></td>
            <td><Ticks checks={r.checks} /><div className="small muted">{r.passed} of {r.asked}</div></td>
            {showMiss && <td className="small">{miss.map((c) => <div key={c.id}><b>{CHECK_LABEL[c.id]}:</b> {c.detail}</div>)}</td>}
            <td className="num">{num(m.avgRoe, "%")}<div className="small muted">{m.minRoe === null ? "" : `low ${m.minRoe}%`}</div></td>
            <td className={`num ${m.growthPct === null ? "" : m.growthPct >= 0 ? "pos" : "neg"}`}>{m.growthPct === null ? "—" : `${m.growthPct > 0 ? "+" : ""}${m.growthPct}% a year`}</td>
            <td className="num">{num(m.debtYears)}</td>
            <td className="num">{num(m.avgMargin, "%")}</td>
            <td className={`num ${m.sharesPct5y === null ? "" : m.sharesPct5y <= 0 ? "pos" : m.sharesPct5y > LONG_TERM.dilution ? "neg" : ""}`}>{m.sharesPct5y === null ? "—" : `${m.sharesPct5y > 0 ? "+" : ""}${m.sharesPct5y}%`}</td>
            <td className="num">{p.pe === null ? <span className="muted" title="No price, a loss last year, or a figure that looks like a data problem (for example a stock split since the year end)">—</span> : <><b>{p.pe}</b><div className={`small ${p.tag === "fair" ? "pos" : p.tag === "expensive" ? "neg" : "muted"}`}>{p.tag}</div></>}</td>
            <td className="num">{p.earningsYieldPct === null ? "—" : `${p.earningsYieldPct}%`}{p.freeCashYieldPct !== null && <span className="muted"> · {p.freeCashYieldPct}%</span>}</td>
            <td className="small">{cardsOn(r.symbol).length ? <CardChips cards={cardsOn(r.symbol)} max={3} symbol={r.symbol} /> : <span className="muted">none</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

/** Long term: companies that pass a Buffett-style check of their own annual reports, with today's price against their profit. */
export default async function LongTermPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [all, briefs, universe] = await Promise.all([longTermRows().catch(() => [] as LongTermRow[]), store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]), longTermUniverse().catch(() => [])]);
  const size = universe.length || LONG_TERM.size;
  const cardsOn = (s: string) => briefs.filter((b) => b.primaryTicker === s || b.tickers.includes(s));
  const measured = all.filter((r) => r.metrics);
  const short = measured.filter((r) => r.verdict !== "no");
  const data = marketDataFromEnv();
  const snaps = (short.length && data?.getSnapshots ? await data.getSnapshots(short.map((r) => r.symbol)).catch(() => ({})) : {}) as Record<string, { price: number }>;
  const priced: Priced[] = short.map((r) => { const price = snaps[r.symbol]?.price ?? null; return { r, price, p: priceOf(r.metrics!, price) }; });
  const byQuality = (a: Priced, b: Priced) => (a.p.pe ?? 999) - (b.p.pe ?? 999) || (b.r.metrics!.avgRoe ?? 0) - (a.r.metrics!.avgRoe ?? 0);
  const passes = priced.filter((x) => x.r.verdict === "passes");
  const fair = passes.filter((x) => x.p.tag === "fair").sort(byQuality);
  const dear = passes.filter((x) => x.p.tag !== "fair").sort(byQuality);
  const oneShort = priced.filter((x) => x.r.verdict === "one short").sort(byQuality);
  const failed = measured.length - short.length, noHistory = all.length - measured.length;
  const newest = all.map((r) => r.computedAt).sort().at(-1) ?? null;
  return (
    <>
      <h1>Long term</h1>
      <section className="card notice small">
        Companies that pass a Warren Buffett style check of their own annual reports. As far as numbers can show it, he looks for a business that earns a high return on its owners&apos; money year after year, makes money every year, grows, carries little debt, turns its profit into cash, keeps a good share of each sales dollar and does not water down its owners, and then for a sensible price: &quot;a wonderful company at a fair price&quot;. The {size.toLocaleString("en-US")} largest companies on the SEC&apos;s list of listed companies are each checked by code against up to {LONG_TERM.maxYears} fiscal years of their annual reports (the SEC&apos;s own data). No AI, and nothing is traded.
        <div style={{ marginTop: 6 }}><b>What this cannot judge, and he weighs most:</b> whether the advantage will last, whether the managers are able and honest, and whether you understand the business. Treat a pass as a short list to read about, not as a buy. The price column uses last year&apos;s profit, which says nothing about next year&apos;s.</div>
        <div className="muted" style={{ marginTop: 6 }}>{all.length.toLocaleString("en-US")} of {size.toLocaleString("en-US")} companies screened{newest ? `, the latest ${fmtEtAgo(newest)}` : ""}{all.length < size ? `. The first pass through the whole list takes an hour or two (a few hundred companies every 10 minutes, largest first); the lists below fill in as it goes.` : `; each is screened again every ${LONG_TERM.refreshDays} days.`} {failed.toLocaleString("en-US")} failed two or more checks and {noHistory.toLocaleString("en-US")} have too little history on file (or are funds); neither is listed.</div>
      </section>

      <section className="card">
        <h2>Passes every check, at a fair price <span className="small muted">({fair.length})</span></h2>
        <p className="small secondary">Every check that could be made is passed, and the stock costs {LONG_TERM.fairPe} times last year&apos;s profit or less. Cheapest first.</p>
        {fair.length ? <Table rows={fair} cardsOn={cardsOn} /> : <p className="small muted">{all.length ? "None right now." : "Nothing screened yet: the first companies appear within 10 minutes of the scheduler's next daytime pass."}</p>}
      </section>

      <section className="card">
        <h2>Passes every check, but the price is full <span className="small muted">({dear.length})</span></h2>
        <p className="small secondary">The same quality, costing more than {LONG_TERM.fairPe} times last year&apos;s profit (over {LONG_TERM.richPe} is marked expensive), or with no usable price figure. A list to watch for a fall, not to chase.</p>
        {dear.length ? <Table rows={dear.slice(0, SHOW)} cardsOn={cardsOn} /> : <p className="small muted">None right now.</p>}
        {dear.length > SHOW && <p className="small muted">The {SHOW} cheapest of {dear.length} are shown.</p>}
      </section>

      <section className="card">
        <details>
          <summary><b>One check short</b> <span className="small muted">({oneShort.length})</span></summary>
          <p className="small secondary">Passes all but one of the checks that could be made. The missed check is named: some misses matter less than others (a dip in one year&apos;s return is not the same as heavy debt).</p>
          {oneShort.length ? <Table rows={oneShort.slice(0, SHOW)} cardsOn={cardsOn} showMiss /> : <p className="small muted">None right now.</p>}
          {oneShort.length > SHOW && <p className="small muted">The {SHOW} cheapest of {oneShort.length} are shown.</p>}
        </details>
      </section>

      <section className="card">
        <details>
          <summary><b>The seven checks, exactly</b></summary>
          <ul className="small">{ORDER.map((id) => <li key={id}><b>{CHECK_LABEL[id]}.</b> {CHECK_ABOUT[id]}</li>)}</ul>
          <p className="small muted">A dash means the check could not be made (a figure the company does not report, equity below zero after large buybacks, or a kind of business it is not asked of). A company needs at least four checks made, and {LONG_TERM.minYears} fiscal years on file, to be listed. Figures are as the company reported them to the SEC; a company that reports in another currency is compared with itself, so the ratios still hold, but its price column is left blank when the figures do not line up.</p>
        </details>
      </section>
    </>
  );
}
