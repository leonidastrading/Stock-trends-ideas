import ResearchButton from "@/components/ResearchButton";
import Ticker from "@/components/Ticker";
import { LEG_NAME, PRE_EARNINGS, preEarningsLine, type Leg, type PreEarningsRow, type ScoreRow } from "@/lib/scout/pre-earnings";

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const when = (r: PreEarningsRow) => `${day(r.reportDate)} · ${r.timing === "before_open" ? "before open" : r.timing === "after_close" ? "after close" : "time not given"}`;
const signed = (x: number | null) => (x === null ? <span className="muted">—</span> : <span className={x > 0 ? "pos" : "neg"}>{x > 0 ? "+" : ""}{x}%</span>);
const vsSpy = (r: PreEarningsRow) => (r.reactionPct === null ? null : Math.round((r.reactionPct - (r.spyPct ?? 0)) * 10) / 10);

function Signs({ legs }: { legs: Leg[] }) {
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: "1.1em" }}>
      {legs.map((l) => <li key={l.kind}><b>{LEG_NAME[l.kind]}:</b> {l.url ? <a href={l.url} target={l.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer">{l.text}</a> : l.text}</li>)}
    </ul>
  );
}

/** Calendar: stocks that report in the next sessions with warning signs already showing, and the screen's record so far. */
export default function PreEarnings({ ahead, past, record }: { ahead: PreEarningsRow[]; past: PreEarningsRow[]; record: ScoreRow[] }) {
  const flagged = ahead.filter((r) => r.flagged).sort((a, b) => a.reportDate.localeCompare(b.reportDate) || b.legs.length - a.legs.length);
  const one = ahead.filter((r) => !r.flagged).sort((a, b) => a.reportDate.localeCompare(b.reportDate) || (b.marketCap ?? 0) - (a.marketCap ?? 0));
  const measured = record.reduce((n, r) => n + r.n, 0);
  const pastFlagged = past.filter((r) => r.flagged);
  return (
    <section className="card" id="pre-earnings">
      <h2>Warning signs before earnings</h2>
      <p className="small secondary">
        Every company worth ${PRE_EARNINGS.minCapUsd / 1e6}M or more that reports in the next {PRE_EARNINGS.aheadSessions} sessions is checked, by code only (no AI), for five signs: it is {Math.abs(PRE_EARNINGS.slide.vsSpy)}+ points behind SPY over {PRE_EARNINGS.slide.days} days; it dropped {PRE_EARNINGS.jolt.times} times its usual daily move with no headline; its latest 10-K or 10-Q added a warning against a year earlier; a short idea on Dots or Themes names it; or it fell through takeover talk. <b>Two or more is a flag.</b> It came from Ambarella&apos;s November 2026 results, where all of this was visible beforehand on different pages. It is new and unproven: a flag is a reason to look, not a call, and the record below is how it earns or loses trust.
      </p>
      {flagged.length === 0 ? <p className="small muted">No stock reporting in the next {PRE_EARNINGS.aheadSessions} sessions shows two signs right now{one.length ? `; ${one.length} show one (below)` : ""}. The screen runs every hour from 6 AM to 8 PM ET.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Reports</th><th>Stock</th><th>Signs seen beforehand</th><th className="num">30 days</th><th></th></tr></thead>
          <tbody>{flagged.map((r) => (
            <tr key={`${r.symbol}-${r.reportDate}`}>
              <td className="small" style={{ whiteSpace: "nowrap" }}>{when(r)}</td>
              <td><Ticker symbol={r.symbol} /> <div className="small muted">{r.name}</div></td>
              <td><Signs legs={r.legs} /></td>
              <td className="num">{signed(r.move30)}{r.spy30 !== null && <div className="small muted">SPY {r.spy30 > 0 ? "+" : ""}{r.spy30}%</div>}</td>
              <td><ResearchButton symbol={r.symbol} term={`${r.symbol} before earnings`} kind="event" from={{ label: "Calendar", url: "/calendar#pre-earnings" }} observation={`${preEarningsLine(r)} Is there a trade into or after the report, and which way? Check each sign against the evidence; the screen that raised them is new and unproven.`} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {one.length > 0 && (
        <details>
          <summary className="small">{one.length} more with one sign (not a flag)</summary>
          <div className="table-wrap"><table>
            <thead><tr><th>Reports</th><th>Stock</th><th>Sign</th><th className="num">30 days</th></tr></thead>
            <tbody>{one.slice(0, 60).map((r) => (
              <tr key={`${r.symbol}-${r.reportDate}`}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{when(r)}</td>
                <td><Ticker symbol={r.symbol} /> <span className="small muted">{r.name}</span></td>
                <td><Signs legs={r.legs} /></td>
                <td className="num">{signed(r.move30)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      )}
      <h3 style={{ marginTop: "1rem" }}>The record so far</h3>
      {measured === 0 ? <p className="small muted">Nothing measured yet. After each report the stock&apos;s reaction is written beside what the screen said beforehand, for flagged stocks and for the rest, so the two can be compared. The first results appear the day after the first screened companies report.</p> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>Before the report</th><th className="num">Reports</th><th className="num">Reaction vs SPY (average)</th><th className="num">Median</th><th className="num">Did worse than SPY</th><th className="num">5+ points worse</th></tr></thead>
            <tbody>{record.map((r) => (
              <tr key={r.group}>
                <td>{r.group === "flagged" ? "Flagged (two or more signs)" : r.group === "one sign" ? "One sign" : "No sign"}</td>
                <td className="num">{r.n}</td>
                <td className="num">{signed(r.vsSpy.mean)}</td>
                <td className="num">{signed(r.vsSpy.median)}</td>
                <td className="num">{r.fellPct === null ? "—" : `${r.fellPct}%`}</td>
                <td className="num">{r.fell5Pct === null ? "—" : `${r.fell5Pct}%`}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="small muted">How to read it: the screen is worth something only if flagged stocks do clearly worse than the &quot;no sign&quot; row, over many reports. The reaction is close to close across the report (the close before it to the close after it), against SPY. Read the counts before the averages: a handful of reports proves nothing.</p>
        </>
      )}
      {pastFlagged.length > 0 && (
        <details>
          <summary className="small">Every flagged stock that has reported ({pastFlagged.length})</summary>
          <div className="table-wrap"><table>
            <thead><tr><th>Reported</th><th>Stock</th><th>Signs seen beforehand</th><th className="num">Reaction</th><th className="num">vs SPY</th></tr></thead>
            <tbody>{pastFlagged.slice(0, 80).map((r) => (
              <tr key={`${r.symbol}-${r.reportDate}`}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{day(r.reportDate)}</td>
                <td><Ticker symbol={r.symbol} /> <span className="small muted">{r.name}</span></td>
                <td><Signs legs={r.legs} /></td>
                <td className="num">{signed(r.reactionPct)}</td>
                <td className="num">{signed(vsSpy(r))}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      )}
    </section>
  );
}
