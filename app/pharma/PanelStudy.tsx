import Ticker from "@/components/Ticker";
import { PANEL_VOTES } from "@/config/panel-votes";
import { PANEL_STUDY, panelTable, type PanelStudyState } from "@/lib/scout/panel-study";
import type { Stat } from "@/lib/scout/rating-study";
import { fmtEtAgo } from "@/lib/time";

const cell = (s: Stat, strong = false) => {
  if (s.mean === null) return <td className="num muted">—</td>;
  return <td className={`num ${s.mean > 0 ? "pos" : "neg"}`} style={strong ? { fontWeight: 600 } : undefined} title={`median ${s.median}%, t = ${s.t ?? "?"}, n = ${s.n}`}>{s.mean > 0 ? "+" : ""}{s.mean}%<span className="muted"> ({s.n})</span>{s.t !== null && Math.abs(s.t) >= 2 ? <b title="t-statistic of 2 or more: unlikely to be chance alone"> *</b> : null}</td>;
};
const signed = (x: number | null) => (x === null ? <span className="muted">—</span> : <span className={x > 0 ? "pos" : "neg"}>{x > 0 ? "+" : ""}{x}%</span>);
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The look-back on FDA advisory panel votes: did trading with the panel pay once the vote was public? */
export default function PanelStudy({ state }: { state: PanelStudyState | null }) {
  const rows = state ? panelTable(state.results) : [];
  const first = PANEL_VOTES.map((v) => v.public).sort()[0]?.slice(0, 4);
  const priced = state?.results.filter((r) => r.entryDate) ?? [];
  return (
    <details className="card section" id="panel-votes" open>
      <summary><b>Panel votes: what trading with the FDA&apos;s advisers returned</b> <span className="small muted">{PANEL_VOTES.length} votes on file since {first}{state ? ` · ${priced.length} priced · measured ${fmtEtAgo(state.at)}` : " · not priced yet: it starts by itself within minutes"}</span></summary>
      <div className="small secondary">
        <p>Before deciding on a drug the FDA often asks a panel of outside experts to vote. The vote is public that day; the decision comes weeks or months later, and the FDA usually follows the panel. The test: from the next open after the vote was public, go <b>with the panel</b> (short after a negative vote, long after a positive one) and hold to the decision, measured against the biotech ETF {PANEL_STUDY.bench}. Votes are read from the companies&apos; own SEC filings, decisions from their later announcements; prices are Alpaca&apos;s, from 2019. No AI is involved, and nothing here is a replay of the scout.</p>
        {rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead>
              <tr><th rowSpan={2}>Panel vote</th><th rowSpan={2} className="num">Votes</th><th rowSpan={2} className="num">FDA then</th><th rowSpan={2} className="num">Stock at once</th><th colSpan={4} className="num">With the panel, vs {PANEL_STUDY.bench}, from the next open (average, count)</th></tr>
              <tr><th className="num">+20 days</th><th className="num">+60 days</th><th className="num">To the decision</th><th className="num">Beat {PANEL_STUDY.bench}</th></tr>
            </thead>
            <tbody>{rows.map((r) => (
              <tr key={r.side}>
                <td>{r.side === "negative" ? "Negative (go short)" : "Positive (go long)"}</td>
                <td className="num">{r.votes}<div className="muted">{r.priced} priced</div></td>
                <td className="num">{r.rejected} rejected<div>{r.approved} approved</div>{r.undecided ? <div className="muted">{r.undecided} not found</div> : null}</td>
                <td className="num" title="The stock's own move from the close before the vote was public to the next open: what the market took before you could act">{r.reaction.mean === null ? "—" : `${r.reaction.mean > 0 ? "+" : ""}${r.reaction.mean}%`}</td>
                {cell(r.h20)}{cell(r.h60)}{cell(r.toDecision, true)}
                <td className="num">{r.winToDecision === null ? "—" : `${r.winToDecision}%`}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="muted">How to read it: a positive number means trading with the panel made money against {PANEL_STUDY.bench}. &quot;Stock at once&quot; is the move you could not catch. The sample is small, so read the counts before the averages, and a star marks an average unlikely to be chance alone. Votes before 2019 and stocks Alpaca has no prices for are counted but not priced{state?.noPrices.length ? ` (${state.noPrices.length} stocks)` : ""}; companies whose filings never said how the FDA decided are &quot;not found&quot;. Large drug makers are left out: one drug rarely moves them.</p>
        {priced.length > 0 && (
          <details>
            <summary>Every negative vote, and what happened</summary>
            <div className="table-wrap"><table>
              <thead><tr><th>Vote public</th><th>Stock</th><th className="num">Vote (for–against)</th><th>FDA decision</th><th className="num">Stock at once</th><th className="num">Short to the decision, vs {PANEL_STUDY.bench}</th><th className="num">+60 days</th></tr></thead>
              <tbody>{state!.results.filter((r) => r.side === "negative").sort((a, b) => b.public.localeCompare(a.public)).map((r) => (
                <tr key={`${r.symbol}-${r.public}`}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}><a href={r.url} target="_blank" rel="noreferrer">{day(r.public)}</a></td>
                  <td><Ticker symbol={r.symbol} /> <span className="small muted">{r.company}</span></td>
                  <td className="num">{r.yes}–{r.no}</td>
                  <td className="small">{r.outcome ? <><span className={r.outcome === "rejected" ? "neg" : "pos"}>{r.outcome}</span> {r.decisionDate ? day(r.decisionDate) : ""}</> : <span className="muted">not found</span>}</td>
                  <td className="num">{r.reactionPct === null ? "—" : `${r.reactionPct > 0 ? "+" : ""}${r.reactionPct}%`}</td>
                  <td className="num">{signed(r.toDecision)}</td>
                  <td className="num">{signed(r.h60)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </details>
        )}
      </div>
    </details>
  );
}
