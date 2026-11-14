import SetupNotice from "@/components/SetupNotice";
import { CHATTER, CHATTER_UNIVERSE } from "@/config/chatter";
import type { DailyBar } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { chatterReport, eventOutcome, GROUP_LABEL, groupOf, nearEarnings, type ChatterReportRow } from "@/lib/scout/chatter";
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
            <tr><th rowSpan={2}>Group</th><th rowSpan={2} className="num">Events</th>{CHATTER.horizons.map((h) => <th key={h} colSpan={3} className="num">{h} session{h > 1 ? "s" : ""} later, vs SPY</th>)}</tr>
            <tr>{CHATTER.horizons.map((h) => [<th key={`${h}m`} className="num">avg</th>, <th key={`${h}h`} className="num">beat SPY</th>, <th key={`${h}a`} className="num">avg size</th>])}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.group}>
                <td>{GROUP_LABEL[r.group]}</td>
                <td className="num">{r.events}</td>
                {CHATTER.horizons.map((h) => {
                  const s = r.byHorizon[h];
                  return [
                    <td key={`${h}m`} className={`num ${cls(s.mean)}`}>{pct(s.mean)}<div className="small muted">n={s.n}</div></td>,
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
  const [status, events, barRows, earnings] = await Promise.all([store.chatterStatus(), store.chatterEvents(), store.loadBars(symbols, CHATTER_EXPLORE_FROM, today), store.earningsDatesBySymbol()]);
  const bars = groupBars(barRows);
  const etf = new Map(CHATTER_UNIVERSE.map((u) => [u.symbol, u.etf]));
  const forward = events.map((e) => ({ ...e, nearEarnings: nearEarnings(e.date, earnings.get(e.symbol)), outcome: eventOutcome(e.date, bars.get(e.symbol) ?? [], bars.get("SPY") ?? [], bars.get(etf.get(e.symbol) ?? "") ?? []) }));
  const fwdRows = chatterReport(forward);
  const spikes = forward.filter((e) => e.kind === "spike").slice().reverse();

  const ex = loadExplore();
  const exEvents = exploreOutcomes(exploreEvents(ex.series), bars);
  const exRows = chatterReport(exEvents.map((e) => ({ kind: e.kind, bullishShare: null, outcome: e.outcome, nearEarnings: nearEarnings(e.date, earnings.get(e.symbol)) })));
  const exSpikes = exEvents.filter((e) => e.kind === "spike").length;

  return (
    <>
      <h1>Chatter test</h1>
      <section className="card notice small">
        Does a spike in Stocktwits chatter while the price is still quiet predict the move? News research says prices under-react and catch up as a story spreads; message-board research says chatter predicts the size of moves more reliably than their direction. This is an experiment beside the scout: nothing here becomes card evidence.
        <br />Fixed in advance: {CHATTER_UNIVERSE.length} stocks ({CHATTER.perSector} per sector). Each weekday every one is measured once (messages per hour over its latest 30, bullish share of tagged messages). A <b>spike</b> is a log rate {CHATTER.spikeZ}+ standard deviations above the stock&apos;s own previous {CHATTER.minHistory}–{CHATTER.lookbackDays} measurements, the first in {CHATTER.episodeGapDays} days. <b>Quiet</b> means the 5 sessions before moved less than {CHATTER.quietPct}% against SPY. About 1 in {CHATTER.controlOneIn} ordinary stock-days is logged as a <b>control</b>. Entry is the next open; results are the excess over SPY after 1, 5 and 20 sessions. &quot;Avg size&quot; is the average move either way, the thing chatter is known to predict. Spikes within 3 days of an earnings release (8-K item 2.02) are a known event and get their own row.
      </section>

      <section className="card">
        <h2>Forward test</h2>
        <p className="small">
          {status.days ? <>Recording since {status.firstDate} · {status.days} weekday{status.days === 1 ? "" : "s"} · last day {status.lastDate}: {status.lastDayCount} of {CHATTER_UNIVERSE.length} measured · {events.filter((e) => e.kind === "spike").length} spikes, {events.filter((e) => e.kind === "control").length} controls logged.</> : <>Not started yet: the first batch runs with the next hourly story call or the after-close job.</>}
          {status.days > 0 && status.days < CHATTER.minHistory && <span className="warn"> Warming up: spikes count once a stock has {CHATTER.minHistory} days of its own history (about {CHATTER.minHistory - status.days} more weekdays).</span>}
        </p>
        <ReportTable rows={fwdRows} note="Outcomes fill in as sessions pass (20-session results need four weeks). Bars load with the after-close job. Expect to need two to three months before the spike rows have enough events to mean anything; compare each row with the control row, not with zero." />
        {spikes.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Stock</th><th className="num">z</th><th className="num">msgs/hour</th><th className="num">usual</th><th className="num">bullish</th><th>Group</th><th className="num">5 sessions vs SPY</th></tr></thead>
            <tbody>{spikes.slice(0, 30).map((e) => {
              const g = e.outcome ? groupOf(e.kind, e.bullishShare, e.outcome.quiet, e.nearEarnings) : null;
              const x = e.outcome?.excess[5] ?? null;
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
            <ReportTable rows={exRows} note="Compare the spike rows with the control row. A real effect would show as a bigger average size (moves either way) and, if chatter leads direction, a consistent average excess." />
          </>
        )}
      </section>
    </>
  );
}
