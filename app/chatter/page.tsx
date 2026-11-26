import SetupNotice from "@/components/SetupNotice";
import { businessDaysFrom } from "@/lib/market/panels";
import { CHATTER, CHATTER_UNIVERSE } from "@/config/chatter";
import type { DailyBar } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { chatterReport, CONTROL_OK, controlNearZero, eventOutcome, GROUP_LABEL, groupOf, hadNews, nearEarnings, universeBenchmark, type ChatterReportRow } from "@/lib/scout/chatter";
import { exploreEvents, exploreOutcomes, loadExplore } from "@/lib/scout/chatter-explore";
import { CHATTER_EXPLORE_FROM } from "@/lib/scout/engine";
import * as store from "@/lib/scout/store";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null, d = 2) => (x === null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const cls = (x: number | null) => (x === null ? "" : x >= 0 ? "pos" : "neg");

function ReportTable({ rows, note }: { rows: ChatterReportRow[]; note: string }) {
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th rowSpan={2}>Group</th><th rowSpan={2} className="num">Events</th>{CHATTER.horizons.map((h) => <th key={h} colSpan={3} className="num">{h} session{h > 1 ? "s" : ""} later, vs the average of the {CHATTER_UNIVERSE.length} stocks</th>)}</tr>
            <tr>{CHATTER.horizons.map((h) => [<th key={`${h}m`} className="num">avg</th>, <th key={`${h}h`} className="num">beat it</th>, <th key={`${h}a`} className="num">avg size</th>])}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.group} style={r.group === "control" ? { borderTop: "2px solid var(--border, #444)" } : undefined}>
                <td>{GROUP_LABEL[r.group]}{r.group === "control" ? <div className="small muted">should sit near zero: it is the test of the yardstick</div> : null}</td>
                <td className="num">{r.events}</td>
                {CHATTER.horizons.map((h) => {
                  const s = r.byHorizonUniverse[h], spy = r.byHorizon[h];
                  return [
                    <td key={`${h}m`} className={`num ${cls(s.mean)}`}>{r.group === "control" ? <b>{pct(s.mean)}</b> : pct(s.mean)}<div className="small muted">n={s.n} · vs SPY {pct(spy.mean)}</div></td>,
                    <td key={`${h}h`} className="num">{s.hit === null ? "—" : `${Math.round(s.hit * 100)}%`}</td>,
                    <td key={`${h}a`} className="num">{s.meanAbs === null ? "—" : `${(s.meanAbs * 100).toFixed(2)}%`}</td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small secondary">{note}</p>
    </>
  );
}

function groupBars(rows: DailyBar[]): Map<string, DailyBar[]> {
  const m = new Map<string, DailyBar[]>();
  for (const b of rows) m.set(b.symbol, [...(m.get(b.symbol) ?? []), b]);
  return m;
}

export default async function ChatterPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const today = toEt(new Date()).date;
  const symbols = [...new Set(["SPY", ...CHATTER_UNIVERSE.flatMap((u) => [u.symbol, u.etf])])];
  const [status, events, barRows, earnings, news] = await Promise.all([store.chatterStatus(), store.chatterEvents(), store.loadBars(symbols, CHATTER_EXPLORE_FROM, today), store.earningsDatesBySymbol(), store.newsDays(CHATTER_EXPLORE_FROM, today)]);
  const bars = groupBars(barRows);
  const etf = new Map(CHATTER_UNIVERSE.map((u) => [u.symbol, u.etf]));
  // The fair benchmark: the equal-weighted average of the test's own stocks over the same days.
  const universe = universeBenchmark(bars, CHATTER_UNIVERSE.map((u) => u.symbol));
  const forward = events.map((e) => ({ ...e, nearEarnings: nearEarnings(e.date, earnings.get(e.symbol)), news: hadNews(e.date, e.symbol, news.bySymbol, news.recorded), outcome: eventOutcome(e.date, bars.get(e.symbol) ?? [], bars.get("SPY") ?? [], bars.get(etf.get(e.symbol) ?? "") ?? [], undefined, universe) }));
  const fwdRows = chatterReport(forward);
  const spikes = forward.filter((e) => e.kind === "spike").slice().reverse();

  const ex = loadExplore();
  const exEvents = exploreOutcomes(exploreEvents(ex.series), bars);
  const exRows = chatterReport(exEvents.map((e) => ({ kind: e.kind, bullishShare: null, outcome: e.outcome, nearEarnings: nearEarnings(e.date, earnings.get(e.symbol)), news: hadNews(e.date, e.symbol, news.bySymbol, news.recorded) })));
  const exSpikes = exEvents.filter((e) => e.kind === "spike").length;
  const exControl = controlNearZero(exRows), fwdControl = controlNearZero(fwdRows);

  return (
    <>
      <h1>Chatter test</h1>
      <section className="card notice small">
        Does a spike in Stocktwits chatter while the price is still quiet predict the move? News research says prices under-react and catch up as a story spreads; message-board research says chatter predicts the size of moves more reliably than their direction. This is an experiment beside the scout: nothing here becomes card evidence.
        <br />Fixed in advance: {CHATTER_UNIVERSE.length} stocks ({CHATTER.perSector} per sector). Each weekday every one is measured once (messages per hour over its latest 30, bullish share of tagged messages). A <b>spike</b> is a log rate {CHATTER.spikeZ}+ standard deviations above the stock&apos;s own previous {CHATTER.minHistory}–{CHATTER.lookbackDays} measurements, the first in {CHATTER.episodeGapDays} days. <b>Quiet</b> means the 5 sessions before moved less than {CHATTER.quietPct}% against SPY. About 1 in {CHATTER.controlOneIn} ordinary stock-days is logged as a <b>control</b>. Entry is the next open; results are the excess over SPY after 1, 5 and 20 sessions. &quot;Avg size&quot; is the average move either way, the thing chatter is known to predict. Spikes within 3 days of an earnings release (8-K item 2.02) are a known event and get their own row. Quiet-price spikes with no story in the news stream that day or the day before get their own row too: news research expects chatter on no news to fade, so compare that row&apos;s average with the &quot;with news&quot; rows.
      </section>

      <section className="card">
        <h2>Forward test</h2>
        <p className="small">
          {status.days ? <>Recording since {status.firstDate} · {status.days} weekday{status.days === 1 ? "" : "s"} · last day {status.lastDate}: {status.lastDayCount} of {CHATTER_UNIVERSE.length} measured · {events.filter((e) => e.kind === "spike").length} spikes, {events.filter((e) => e.kind === "control").length} controls logged.</> : <>Not started yet: the first batch runs with the next hourly story call or the after-close job.</>}
          {status.days > 0 && status.days < CHATTER.minHistory && <span className="warn"> Warming up: spikes count once a stock has {CHATTER.minHistory} days of its own history, about {CHATTER.minHistory - status.days} more weekdays (around {new Date(`${businessDaysFrom(status.lastDate ?? "", CHATTER.minHistory - status.days + 1).at(-1)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}).</span>}
        </p>
        {events.length > 0
          ? <>{!fwdControl.ok && <p className="small warn">Not readable yet: the control row (ordinary random days) is at {pct(fwdControl.mean)} over 5 sessions from {fwdControl.n} events. It has to sit within {(CONTROL_OK.maxAbs * 100).toFixed(1)}% of zero, with at least {CONTROL_OK.minEvents} events, before a gap in the spike rows means anything.</p>}<ReportTable rows={fwdRows} note="Outcomes fill in as sessions pass (20-session results need four weeks). Bars load with the after-close job. Expect to need two to three months before the spike rows have enough events to mean anything; compare each row with the control row, not with zero. Each row is measured against the equal-weighted average of the test's own stocks over the same days (the small figure is the same against SPY)." /></>
          : <p className="small muted">The results table appears with the first spike or control. Until then the scout is only recording each stock&apos;s chatter rate every weekday; nothing is missing.</p>}
        {spikes.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Stock</th><th className="num">z</th><th className="num">msgs/hour</th><th className="num">usual</th><th className="num">bullish</th><th>Group</th><th className="num">5 sessions vs the stocks&apos; average</th></tr></thead>
            <tbody>{spikes.slice(0, 30).map((e) => {
              const g = e.outcome ? groupOf(e.kind, e.bullishShare, e.outcome.quiet, e.nearEarnings, e.news) : null;
              const x = e.outcome?.excessUniverse?.[5] ?? null;
              return <tr key={e.id}><td className="small">{e.date}</td><td><b>{e.symbol}</b></td><td className="num">{e.z?.toFixed(1)}</td><td className="num">{e.perHour}</td><td className="num">{e.baselinePerHour ?? "—"}</td><td className="num">{e.bullishShare === null ? "—" : `${Math.round(e.bullishShare * 100)}%`}</td><td className="small">{g ? GROUP_LABEL[g] : "waiting for bars"}</td><td className={`num ${cls(x)}`}>{pct(x)}</td></tr>;
            })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h2>Look-back (exploratory)</h2>
        {ex.files === 0 ? <p className="small muted">No look-back data loaded.</p> : (
          <>
            <p className="small secondary">
              Stocktwits&apos; own message-volume history for the same stocks ({Object.keys(ex.series).length} with data, fetched {ex.fetched}), run through the same spike rule on its daily score{ex.dropped.length ? ` (left out as unreadable: ${ex.dropped.join(", ")})` : ""}: {exSpikes} spikes, {exEvents.length - exSpikes} controls.
              <b> Treat it as a sanity check, not evidence:</b> the score is scaled over the whole window it was fetched for (part of each day&apos;s value depends on later days), it is smoothed so spikes show late, and it has no sentiment, so every spike lands in &quot;mixed&quot;.
              {(barRows.length === 0 || earnings.size === 0) && <span className="warn"> {barRows.length === 0 ? "No bars" : "No earnings dates"} loaded yet: press &quot;Run the tracker now&quot; on Settings once (it loads prices and the companies&apos; earnings dates from SEC filings), then reload.</span>}
            </p>
            {exControl.ok
              ? <ReportTable rows={exRows} note="Compare the spike rows with the control row. A real effect would show as a bigger average size (moves either way) and, if chatter leads direction, a consistent average excess." />
              : <p className="small warn">The look-back table is hidden for now. Its control row (ordinary random days) is at {pct(exControl.mean)} over 5 sessions against the stocks&apos; own average{exControl.n < CONTROL_OK.minEvents ? `, from only ${exControl.n} events` : ""}. Until random days come out within {(CONTROL_OK.maxAbs * 100).toFixed(1)}% of zero with at least {CONTROL_OK.minEvents} events, a gap in the spike rows would be the yardstick, not chatter.</p>}
          </>
        )}
      </section>
    </>
  );
}
