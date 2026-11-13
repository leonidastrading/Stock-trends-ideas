import SetupNotice from "@/components/SetupNotice";
import { KIND_LABEL, SCOUT, type Kind } from "@/config/scout";
import { UNIVERSE } from "@/config/universe";
import { hasDatabase } from "@/lib/db";
import { buildReport, ideaResult, type GroupStats, type IdeaResult } from "@/lib/scout/scoring";
import * as store from "@/lib/scout/store";
import { groupBars } from "@/lib/scout/tracking";
import { addDays, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const cls = (x: number | null | undefined) => (x === null || x === undefined ? "" : x >= 0 ? "pos" : "neg");

function StatsRow({ label, s }: { label: string; s: GroupStats }) {
  return (
    <tr><td>{label}</td><td className="num">{s.n}</td><td className="num">{s.closed}</td><td className="num">{s.winRateVsSpy === null ? "—" : `${Math.round(s.winRateVsSpy * 100)}%`}</td>
      <td className={`num ${cls(s.avgExcess)}`}>{pct(s.avgExcess)}</td><td className={`num ${cls(s.medianExcess)}`}>{pct(s.medianExcess)}</td><td className={`num ${cls(s.avgExcessSector)}`}>{pct(s.avgExcessSector)}</td>
      <td className="num neg">{s.avgDrawdownPct === null ? "—" : `${s.avgDrawdownPct.toFixed(1)}%`}</td></tr>
  );
}

function StatsTable({ title, rows, note }: { title: string; rows: Array<[string, GroupStats]>; note?: string }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {note && <p className="small secondary">{note}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th></th><th className="num">Ideas</th><th className="num">Closed</th><th className="num">Win rate vs SPY</th><th className="num">Avg excess vs SPY</th><th className="num">Median excess</th><th className="num">Avg excess vs sector</th><th className="num">Avg worst drawdown</th></tr></thead>
          <tbody>{rows.map(([l, s]) => <StatsRow key={l} label={l} s={s} />)}</tbody>
        </table>
      </div>
    </section>
  );
}

export default async function ScoringPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const [versions, cards, tracks] = await Promise.all([store.listVersions(), store.allCards(), store.allTracks()]);
  const vid = Number(sp.v) || versions[versions.length - 1]?.id || 0;
  const vCards = cards.filter((c) => c.versionId === vid);
  const byCard = new Map(vCards.map((c) => [c.id, c]));
  const vTracks = tracks.filter((t) => byCard.has(t.cardId) && t.entryDate);
  const earliest = vTracks.map((t) => t.entryDate!).sort()[0];
  const today = toEt(new Date()).date;
  const symbols = [...new Set([...vTracks.flatMap((t) => [t.symbol, "SPY", t.sectorEtf]), ...vCards.flatMap((c) => UNIVERSE[c.sector as keyof typeof UNIVERSE] ?? [])])];
  const bars = earliest ? groupBars(await store.loadBars(symbols, addDays(earliest, -3), today)) : new Map();
  const ideas = vTracks.map((t) => ideaResult(byCard.get(t.cardId)!, t, bars)).filter((x): x is IdeaResult => x !== null);
  const report = buildReport(ideas, vCards[0]?.createdAt ?? null, new Date());
  const version = versions.find((v) => v.id === vid);
  return (
    <>
      <h1>Scoring</h1>
      <section className="card notice small">
        Per version. Each idea runs on paper from the next open after its card to the earlier of the day after the catalyst, the time limit, or the invalidation being marked. Return against SPY and the sector fund over the same days; worst drawdown while held. Open ideas are shown at the latest close and not counted in the statistics. Forward results only: no past dates are replayed through the model.
        <div className="inline" style={{ marginTop: 6 }}>Version: {versions.map((v) => <a key={v.id} href={`?v=${v.id}`} className={v.id === vid ? "tag ok" : "tag"}>v{v.id} · {v.model} · {v.effort}</a>)}{version && <span className="muted">hash {version.hash.slice(0, 12)} · since {toEt(new Date(version.createdAt)).date}</span>}</div>
      </section>

      <section className="card">
        <h2>Verdict</h2>
        <p>
          {report.verdict.due ? <b className={report.verdict.pass ? "pos" : "neg"}>{report.verdict.pass ? "PASS" : "FAIL"}</b> : <b>Not yet</b>} — {report.verdict.reason}.
        </p>
        <p className="small secondary">Pass only if the average excess return over SPY of promoted ideas is positive and above the {SCOUT.verdictPercentile * 100}th percentile of the random same-sector baseline, after {SCOUT.verdictClosedIdeas} closed promoted ideas or {SCOUT.verdictMonths} months, whichever is later.</p>
        <div className="grid">
          <div><div className="small secondary">Random-sector baseline (mean of {report.baseline.trials} trials)</div><b className={cls(report.baseline.mean)}>{pct(report.baseline.mean)}</b> <span className="muted small">5th {pct(report.baseline.p5)} · 95th {pct(report.baseline.p95)}</span></div>
          <div><div className="small secondary">Percentile of the scout's average</div><b>{report.baseline.percentileOfActual === null ? "—" : Math.round(report.baseline.percentileOfActual * 100)}</b></div>
          <div><div className="small secondary">Closed promoted ideas</div><b>{report.verdict.closedPromoted}</b> <span className="muted small">of {SCOUT.verdictClosedIdeas}</span></div>
          <div><div className="small secondary">Months running</div><b>{report.verdict.months}</b> <span className="muted small">of {SCOUT.verdictMonths}</span></div>
        </div>
      </section>

      <StatsTable title="By origin" rows={[["Scout-originated", report.byOrigin.scout], ["Human-originated", report.byOrigin.human], ["Human ideas Vadim tapped", report.byOrigin.human_tapped]]} note="Does the scout beat the market, do Vadim's own ideas, and does the research add anything to an idea he noticed himself?" />
      <StatsTable title="By kind" rows={Object.entries(report.byKind).map(([k, s]) => [KIND_LABEL[k as Kind] ?? k, s])} />
      <StatsTable title="Promoted versus late" rows={[["Promoted", report.byStatus.promoted], ["Late (already obvious)", report.byStatus.late]]} note="If late ideas do as well as promoted ones, the lateness gate is not helping." />
      <StatsTable title="By score band" rows={[["High (novelty × materiality ≥ 49)", report.byBand.high], ["Low (< 49)", report.byBand.low]]} note="Do high-novelty, high-materiality cards do better than low ones?" />

      <section className="card">
        <h2>Ideas</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Idea</th><th>Status</th><th>Entry</th><th>Exit</th><th className="num">Return</th><th className="num">SPY</th><th className="num">Excess</th><th className="num">vs sector</th><th className="num">Worst DD</th><th className="num">Baseline (20 draws)</th></tr></thead>
            <tbody>
              {ideas.slice().reverse().map((i) => {
                const c = byCard.get(i.cardId)!;
                const base = i.baseline.length ? i.baseline.reduce((a, b) => a + b, 0) / i.baseline.length : null;
                return (
                  <tr key={i.cardId}>
                    <td>{i.cardId}</td>
                    <td><b className={i.direction === "long" ? "pos" : "neg"}>{i.direction === "long" ? "▲" : "▼"} {i.symbol}</b> <span className="small secondary">{c.title}</span><div className="small muted">{KIND_LABEL[c.kind as Kind]} · {i.origin}{i.tapped ? " · tapped" : ""} · rank {i.rankScore}</div></td>
                    <td><span className={`tag ${i.status}`}>{i.status}</span>{!i.closed && <span className="tag">open</span>}</td>
                    <td className="small">{i.entryDate}</td><td className="small">{i.exitDate ?? "—"}</td>
                    <td className={`num ${cls(i.ret)}`}>{pct(i.ret)}</td><td className="num">{pct(i.spyRet)}</td><td className={`num ${cls(i.excess)}`}>{pct(i.excess)}</td><td className={`num ${cls(i.excessSector)}`}>{pct(i.excessSector)}</td>
                    <td className="num neg">{i.maxDrawdownPct === null ? "—" : `${i.maxDrawdownPct.toFixed(1)}%`}</td><td className={`num ${cls(base)}`}>{pct(base)}</td>
                  </tr>
                );
              })}
              {ideas.length === 0 && <tr><td colSpan={11} className="muted">No tracked ideas with an entry yet. Tracks enter at the next open once the after-close job has run.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small"><a href="/api/export">Download every card and track as CSV</a></p>
      </section>
    </>
  );
}
