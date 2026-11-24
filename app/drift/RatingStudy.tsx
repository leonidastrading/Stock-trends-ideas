import { RATING_STUDY, studySymbols, studyTable, type Stat, type StudyEvent, type StudyState } from "@/lib/scout/rating-study";
import { etLabelAgo } from "@/lib/time";

const cell = (s: Stat, short = true, strong = false) => {
  if (s.mean === null) return <td className="num muted">—</td>;
  // For a short, a negative number is the trade working.
  const good = short ? s.mean < 0 : s.mean > 0;
  return <td className={`num ${good ? "pos" : "neg"}`} style={strong ? { fontWeight: 600 } : undefined} title={`median ${s.median}%, ${s.negShare}% below zero, t = ${s.t ?? "?"}, n = ${s.n}`}>{s.mean > 0 ? "+" : ""}{s.mean}%{s.t !== null && Math.abs(s.t) >= 2 ? <b title="t-statistic of 2 or more: unlikely to be chance alone"> *</b> : null}</td>;
};

/** The look-back: what large and mid caps did after analyst downgrades (and upgrades) since 2019. */
export default function RatingStudy({ state, events }: { state: StudyState | null; events: StudyEvent[] }) {
  const total = studySymbols().length;
  const rows = studyTable(events);
  const downs = events.filter((e) => e.kind === "downgrade").length, ups = events.filter((e) => e.kind === "upgrade").length;
  const waiting = !!state && !state.done && state.calls >= RATING_STUDY.perDay;
  return (
    <details className="card section" open={!!state?.done}>
      <summary><b>Downgrade study, {RATING_STUDY.start.slice(0, 4)} to {state?.end ? new Date(`${state.end}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "now"}</b> <span className="small muted">
        {!state ? "not started yet: it starts by itself"
          : state.done ? `${downs.toLocaleString("en-US")} downgrades and ${ups.toLocaleString("en-US")} upgrades on ${total - state.empty.length} of ${total} stocks`
          : `reading rating histories: ${state.next} of ${total} stocks (${state.next - state.empty.length} with data) · ${state.events.toLocaleString("en-US")} rating changes measured · last pass ${etLabelAgo(state.updatedAt)}${waiting ? " · today's allowance of requests is used; it goes on tomorrow" : ""}${state.error ? ` · stopped: ${state.error}` : ""}`}
      </span></summary>
      <div className="small secondary">
        <p>Does a stock keep falling after an analyst downgrade? Every rating change on file at Financial Modeling Prep for the scout&apos;s {total} large and mid caps, and what the stock did next against SPY (Alpaca&apos;s daily prices). No AI is involved.</p>
        {!state?.done && events.length > 0 && <p className="warn">Not finished: the numbers below cover only the stocks read so far (alphabetically) and will change.</p>}
        {events.length > 0 && (
          <div className="table-wrap"><table>
            <thead>
              <tr><th rowSpan={2}>Group</th><th rowSpan={2} className="num">Events</th><th rowSpan={2} className="num">Reaction day</th><th colSpan={4} className="num">From the next open (tradable)</th><th colSpan={2} className="num">From the reaction close</th><th rowSpan={2} className="num">Below zero at +20</th></tr>
              <tr><th className="num">+5 days</th><th className="num">+10</th><th className="num">+20</th><th className="num">+60</th><th className="num">+20</th><th className="num">+60</th></tr>
            </thead>
            <tbody>{rows.map((r) => {
              const short = !/upgrade/i.test(r.label);
              return (
                <tr key={r.label}>
                  <td>{r.label}</td><td className="num">{r.n.toLocaleString("en-US")}</td>
                  {cell(r.reaction, short)}{cell(r.o5, short, true)}{cell(r.o10, short, true)}{cell(r.o20, short, true)}{cell(r.o60, short, true)}{cell(r.x20, short)}{cell(r.x60, short)}
                  <td className="num">{r.o20.negShare === null ? "—" : `${r.o20.negShare}%`}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <p>How to read it: each number is the average return against SPY, in percent. Green is the direction a trade would want: down after a downgrade, up after an upgrade. A star marks an average unlikely to be chance alone. Hover a number for the median, the share below zero and the count.</p>
        <p><b>Trust the &quot;from the next open&quot; columns.</b> The rating history gives a date but no time. A downgrade published after the close shows its fall the next day, which the &quot;from the reaction close&quot; columns would wrongly count as drift. Entering at the next session&apos;s open is after the news either way, and it is what could actually be traded.</p>
        <p className="muted">Limits: the stock list is today&apos;s, so companies that have since fallen out of it are missing, which hides some of the worst outcomes after downgrades. The history is what the provider has on file now{state?.empty.length ? `; it gave nothing for ${state.empty.length} of the ${state.next} stocks asked so far (${state.empty.slice(0, 12).join(", ")}${state.empty.length > 12 ? "…" : ""})${state.refusal ? `, answering "${state.refusal.replace(/^[A-Z.]+: /, "").slice(0, 160)}"` : ""}` : ""}. Several brokers on one stock on one day count once. Stocks under ${RATING_STUDY.minPrice} are left out. This is a look-back on prices, not a forward test: the Drift desk&apos;s own paper shorts are the forward test.</p>
      </div>
    </details>
  );
}
