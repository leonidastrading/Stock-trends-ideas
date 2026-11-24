import { RATING_STUDY, studySymbols, studyTable, type Stat, type StudyEvent, type StudyState } from "@/lib/scout/rating-study";
import { etLabelAgo } from "@/lib/time";

const cell = (s: Stat, short = true) => {
  if (s.mean === null) return <td className="num muted">—</td>;
  // For a short, a negative number is the trade working.
  const good = short ? s.mean < 0 : s.mean > 0;
  return <td className={`num ${good ? "pos" : "neg"}`} title={`median ${s.median}%, ${s.negShare}% below zero, t = ${s.t ?? "?"}, n = ${s.n}`}>{s.mean > 0 ? "+" : ""}{s.mean}%{s.t !== null && Math.abs(s.t) >= 2 ? <b title="t-statistic of 2 or more: unlikely to be chance alone"> *</b> : null}</td>;
};

/** The look-back: what large and mid caps did after analyst downgrades (and upgrades), 2019 to mid-2025. */
export default function RatingStudy({ state, events }: { state: StudyState | null; events: StudyEvent[] }) {
  const batches = Math.ceil(studySymbols().length / RATING_STUDY.batch);
  const rows = studyTable(events);
  return (
    <details className="card section" open={!!state?.done}>
      <summary><b>Downgrade study, {RATING_STUDY.start.slice(0, 4)} to mid-{RATING_STUDY.end.slice(0, 4)}</b> <span className="small muted">
        {!state ? "not started yet: it starts by itself" : state.done ? `${events.filter((e) => e.kind === "downgrade").length.toLocaleString("en-US")} downgrades and ${events.filter((e) => e.kind === "upgrade").length.toLocaleString("en-US")} upgrades on ${studySymbols().length} stocks` : `reading the news history: batch ${state.batch + 1} of ${batches}${state.at ? `, at ${state.at.slice(0, 7)}` : ""} · ${state.headlines.toLocaleString("en-US")} headlines read, ${state.events.toLocaleString("en-US")} rating changes found · last pass ${etLabelAgo(state.updatedAt)}${state.error ? ` · stopped: ${state.error}` : ""}`}
      </span></summary>
      <div className="small secondary">
        <p>Does a stock keep falling after an analyst downgrade? Every rating headline in the news history for the scout&apos;s {studySymbols().length} large and mid caps, and what the stock did next against SPY. The reaction day is the first session whose close came after the headline. No AI is involved: headlines are matched by their wording, returns come from daily prices.</p>
        {!state?.done && events.length > 0 && <p className="warn">Not finished: the numbers below cover only the stocks read so far and will change.</p>}
        {events.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Group</th><th className="num">Events</th><th className="num">Reaction day</th><th className="num">+5 days</th><th className="num">+10</th><th className="num">+20</th><th className="num">+60</th><th className="num">+20 from next open</th><th className="num">+60 from next open</th><th className="num">Below zero at +20</th></tr></thead>
            <tbody>{rows.map((r) => {
              const short = !/upgrade/i.test(r.label);
              return (
                <tr key={r.label}>
                  <td>{r.label}</td><td className="num">{r.n.toLocaleString("en-US")}</td>
                  {cell(r.reaction, short)}{cell(r.x5, short)}{cell(r.x10, short)}{cell(r.x20, short)}{cell(r.x60, short)}{cell(r.o20, short)}{cell(r.o60, short)}
                  <td className="num">{r.x20.negShare === null ? "—" : `${r.x20.negShare}%`}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <p>How to read it: each number is the average return against SPY, in percent, from the reaction-day close (or from the next session&apos;s open, which is what could actually be traded). Green means the direction a trade would want: down after a downgrade, up after an upgrade. A star marks an average unlikely to be chance alone. Hover a number for the median, the share below zero and the count.</p>
        <p className="muted">Limits: the stock list is today&apos;s, so companies that have since fallen out of it are missing, which hides some of the worst outcomes after downgrades. A rating change is only counted when its headline has the usual wording (&quot;Broker Downgrades Company to Rating&quot;). Several brokers on one stock on one day count once. Stocks under ${RATING_STUDY.minPrice} are left out. This is a look-back on prices, not a forward test: the Drift desk&apos;s own paper shorts above are the forward test.</p>
      </div>
    </details>
  );
}
