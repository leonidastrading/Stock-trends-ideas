import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { panel } from "@/lib/market/panels";
import { DRIFT, scanDrift, shortLine, type DriftSetup } from "@/lib/scout/drift";
import * as store from "@/lib/scout/store";
import { etLabelAgo, dayAgo } from "@/lib/time";
import DriftResearch from "./DriftResearch";
import StockChart from "@/components/StockChart";
import { tvSymbol } from "@/config/links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const pct = (x: number) => `${x > 0 ? "+" : ""}${x}%`;
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) + ` (${dayAgo(d)})`;

/** Down drift: stocks still falling days after bad news. */
export default async function DriftPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const data = marketDataFromEnv();
  const [p, cands, cards] = await Promise.all([
    data ? panel("drift", 24 * 60, () => scanDrift(data), 100_000) : Promise.resolve({ data: null, updatedAt: null, error: "Alpaca keys not set" }),
    store.candidatesSince(60), store.cardsSince(60),
  ]);
  const cardById = new Map(cards.map((c) => [c.id, c]));
  // The desk's cards, by stock (newest first).
  const bySym = new Map<string, Array<{ id: number; status: string }>>();
  for (const c of cands) {
    if (!c.term.startsWith("drift: ") || !c.cardId) continue;
    const card = cardById.get(c.cardId);
    if (!card) continue;
    bySym.set(card.primaryTicker, [...(bySym.get(card.primaryTicker) ?? []), { id: card.id, status: card.status }]);
  }
  const setups: DriftSetup[] = p.data?.setups ?? [];
  return (
    <>
      <h1>Drift</h1>
      <div className="toolbar"><span className="filter-links small"><a className="chip active" href="/drift">Down drift (bad news)</a><a className="chip" href="/earnings">Earnings drift (up)</a></span></div>
      <details className="card section">
        <summary><b>How this page works</b> <span className="small muted">stocks still falling days after bad news</span></summary>
        <div className="small secondary">
          <p>Each hour the scout checks about 700 stocks: large and mid caps, every day&apos;s biggest losers, stocks in negative headlines and stocks with bad-news 8-Ks. A stock is listed when:</p>
          <ul>
            <li>it fell at least {DRIFT.minDropPct}% more than SPY in one day in the last {DRIFT.lookbackDays} trading days,</li>
            <li>that drop lines up with a negative event: an FDA or trial setback, a guidance cut, an earnings miss, a downgrade, an investigation, a short report, an offering, distress, an executive exit, a dividend cut, lost business or a bad-news 8-K (drops without news tend to bounce, so they are left out),</li>
            <li>and it kept falling: at least {DRIFT.minFurtherPct}% more against SPY over the next {DRIFT.minDaysAfter} to {DRIFT.maxDaysAfter} trading days, no more than {DRIFT.maxBouncePct}% off its low, last price ${DRIFT.minPrice} or more.</li>
          </ul>
          <p>Why: bad public news is followed by drift lasting months, while no-news moves tend to reverse (Chan 2003); bad news travels slowly in thinly covered stocks (Hong, Lim &amp; Stein 2000); negative news wording predicts weak earnings and returns (Tetlock et al. 2008; Lopez-Lira &amp; Tang find it strongest for negative news and small caps); holders sitting on gains sell slowly (Frazzini 2006).</p>
          <p>The freshest setups (up to {DRIFT.researchMaxDaysAfter} trading days after the event) are researched automatically, at most {DRIFT.maxResearchPerDay} a day, as short ideas held about 20 trading days on paper; they score as &quot;Scout · down drift&quot; on the Scoreboard. Your short rules still apply (nothing under $5, nothing that ran up hard just before). Much of the documented drift is in small stocks that can be hard or costly to short; short interest (% of float, days to cover) comes from Schwab when it is connected in Settings; borrow cost is not available.</p>
          <p><b>Building</b> = 2-5 trading days since the event; <b>established</b> = 6-15.</p>
        </div>
      </details>
      <p className="small muted">
        {p.data ? <>{setups.length} setup{setups.length === 1 ? "" : "s"} from {p.data.scanned.toLocaleString("en-US")} stocks, prices to {day(p.data.asOf)}{p.updatedAt ? ` · checked ${etLabelAgo(p.updatedAt)}` : ""}</> : p.error ? <span className="neg">Scan failed: {p.error}</span> : "The first scan runs with the hourly job."}
        {p.data && p.error ? <span className="warn"> · latest refresh failed: {p.error}</span> : null}
      </p>
      {p.data && setups.length === 0 && <p className="small muted">Nothing qualifies right now.</p>}
      {setups.map((s) => {
        const mine = bySym.get(s.symbol) ?? [];
        return (
          <section key={s.symbol} className="card drift-item">
            <div>
              <Ticker symbol={s.symbol} className="neg" /> <span className={`tag ${s.stage === "building" ? "late" : ""}`}>{s.stage}</span> <span className="small secondary">{s.eventKind} · {day(s.eventDate)}</span>
            </div>
            <div>{s.eventUrl ? <a href={s.eventUrl} target="_blank" rel="noreferrer">{s.eventHeadline}</a> : s.eventHeadline}</div>
            <div className="small">
              <b className="neg">{pct(s.dayPct)}</b> on the day ({pct(s.dayVsSpy)} vs SPY) · <b className="neg">{pct(s.sincePct)}</b> since ({pct(s.sinceVsSpy)} vs SPY) over {s.daysAfter} trading days, down on {s.downDays} · <b>{pct(s.totalPct)}</b> in total · {s.bouncePct}% off the low · ${s.price}
            </div>
            <div className="small muted">
              {shortLine(s) ? <span className={s.short?.squeeze === "high" ? "warn" : ""}>{shortLine(s)} · </span> : null}{s.volRatio ? `event-day volume ${s.volRatio}× normal · ` : ""}{s.badAfter} bad headline{s.badAfter === 1 ? "" : "s"} since{s.lawsuitAds ? ` (+${s.lawsuitAds} law-firm lawsuit ads)` : ""} · strength {s.score}
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              {mine.length ? mine.map((c) => <a key={c.id} href={`/ideas?days=90&card=${c.id}#card-${c.id}`} style={{ marginRight: 8 }}>card #{c.id} ({c.status.replace("_", " ")})</a>) : <DriftResearch symbol={s.symbol} />}
            </div>
            {s.headlines.length > 0 && (
              <details className="small"><summary>Bad headlines ({s.headlines.length})</summary>
                {s.headlines.map((h, i) => <div key={i}>{day(h.date)} {h.kind ? <span className="tag">{h.kind}</span> : null} <a href={h.url} target="_blank" rel="noreferrer">{h.headline}</a></div>)}
              </details>
            )}
            {/* The bad-news day marked on the chart, at that day's close. */}
            <div style={{ marginTop: 10 }}><StockChart symbol={s.symbol} tvSymbol={tvSymbol(s.symbol)} height={440} entry={{ date: s.eventDate, price: null, direction: "short", label: `${s.eventKind}` }} /></div>
          </section>
        );
      })}
    </>
  );
}
