import CardActions from "@/components/CardActions";
import CardView from "@/components/CardView";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { opposingCalls, upcomingCatalysts } from "@/lib/scout/calendar";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";
import { fmtEt, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CandidatesPage({ searchParams }: { searchParams: Promise<{ days?: string; card?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = Math.min(90, Math.max(1, Number(sp.days ?? 7) || 7));
  const [candidates, cards, tracks, runs, fb, recent] = await Promise.all([store.candidatesSince(days), store.cardsSince(days), store.allTracks(), store.recentRuns(10), store.latestFeedback(), store.cardsSince(120)]);
  const opp = opposingCalls(recent, tracks);
  const reviews = await store.allReviews();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const sw = swingConfigured();
  const running = runs.find((r) => r.action === "daily" && r.status === "running");
  const lastDaily = runs.find((r) => r.action === "daily" && r.status !== "running");
  const measured = (lastDaily?.detail as { measured?: Array<{ term: string; kind: string; sources: number; accelerating: number; score: number; candidate: boolean; cooldown: boolean }>; risingQueries?: Array<{ title: string; traffic: string }>; stoppedEarly?: string | null; discovery?: { headlinesRead: number; read: string | null; proposed: Array<{ term: string; kind: string; tickers: string[]; why: string }>; problems: string[]; error: string | null } | null } | null) ?? null;
  return (
    <>
      <h1>Candidates</h1>
      <p className="small secondary">Everything the scout logged in the last {days} days, newest first, including what it rejected and why. <a href="?days=7">7d</a> · <a href="?days=30">30d</a> · <a href="?days=90">90d</a></p>
      {running && <p className="small warn">A scan started at {running.startedAt.replace("T", " ").slice(0, 16)}Z is still running; refresh in a few minutes.</p>}
      {lastDaily && (
        <section className="card">
          <h2>Last scan · {toEt(new Date(lastDaily.startedAt)).date} · {lastDaily.status}{lastDaily.error ? ` · ${lastDaily.error}` : ""}</h2>
          {measured?.stoppedEarly && <p className="warn small">{measured.stoppedEarly}</p>}
          {measured?.discovery && (
            <div className="card" style={{ marginBottom: 10 }}>
              <h3>Discovery · {measured.discovery.headlinesRead} headlines read</h3>
              {measured.discovery.read && <p className="small">{measured.discovery.read}</p>}
              {measured.discovery.error && <p className="small neg">{measured.discovery.error}</p>}
              {measured.discovery.proposed.length > 0 ? (
                <ul className="small">{measured.discovery.proposed.map((p) => <li key={p.term}><b>{p.term}</b> <span className="tag">{p.kind.replace("_", "-")}</span> {p.tickers.join(", ")} — {p.why}</li>)}</ul>
              ) : !measured.discovery.error && <p className="small muted">Nothing proposed today.</p>}
              {measured.discovery.problems.length > 0 && <p className="small muted">Inputs not available: {measured.discovery.problems.join("; ")}</p>}
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Watch-list term</th><th>Kind</th><th className="num">Sources with data</th><th className="num">Accelerating</th><th className="num">Score</th><th>Result</th></tr></thead>
              <tbody>
                {(measured?.measured ?? []).sort((a, b) => b.score - a.score).map((m) => (
                  <tr key={m.term}><td>{m.term}</td><td className="small">{m.kind}</td><td className="num">{m.sources}</td><td className="num">{m.accelerating}</td><td className="num">{m.score}</td>
                    <td className="small">{m.candidate ? (m.cooldown ? "candidate, but researched within 7 days" : "candidate") : "not accelerating"}</td></tr>
                ))}
                {!measured?.measured?.length && <tr><td colSpan={6} className="muted">No measurements recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          {measured?.risingQueries && measured.risingQueries.length > 0 && (
            <details style={{ marginTop: 8 }}><summary>Google rising queries seen (not on the watch-list; add any that matter)</summary>
              <p className="small">{measured.risingQueries.map((q) => `${q.title} (${q.traffic})`).join(" · ")}</p></details>
          )}
        </section>
      )}
      <section className="card">
        <h2>Log</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Origin</th><th>Term</th><th>Outcome</th><th>Why</th></tr></thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtEt(c.createdAt)}</td>
                  <td className="small">{c.origin}</td>
                  <td>{c.term}{c.observation ? <div className="small muted">“{c.observation}”</div> : null}</td>
                  <td><span className={`tag ${c.outcome === "card" ? (c.reason ?? "") : c.outcome}`}>{c.outcome === "card" ? c.reason?.replace("_", " ") : c.outcome}</span>{c.cardId ? <a className="small" href={`#card-${c.cardId}`}>#{c.cardId}</a> : null}</td>
                  <td className="small secondary">{c.outcome === "card" ? byId.get(c.cardId!)?.gateNotes.join(" · ") : c.reason}{c.trigger?.length ? <div className="muted">flagged by: {c.trigger.map((s) => `${s.source} ${s.changeVs12m === null ? "" : `${s.changeVs12m >= 0 ? "+" : ""}${Math.round(s.changeVs12m * 100)}%`}`).join(", ")}</div> : null}</td>
                </tr>
              ))}
              {candidates.length === 0 && <tr><td colSpan={5} className="muted">Nothing logged in this window.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <h2>Cards</h2>
      {cards.map((c) => {
        const tr = t.get(c.id) ?? null;
        return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} />} />;
      })}
    </>
  );
}
