import SetupNotice from "@/components/SetupNotice";
import { KIND_LABEL, type Kind } from "@/config/scout";
import { hasDatabase } from "@/lib/db";
import { loadIdeas } from "@/lib/scout/ideas-load";
import { byKind, calibration, PLAYER_LABEL, PLAYERS, playerOf, STAKE, standings, toRound, type Round, type Standing } from "@/lib/scout/scoreboard";
import * as store from "@/lib/scout/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pts = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toLocaleString("en-US")}`);
const cls = (x: number | null | undefined) => (!x ? "" : x > 0 ? "pos" : "neg");
const pc = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const VERDICT: Record<string, string> = { played_out: "played out", did_not: "did not play out", mixed: "mixed", too_early: "too early to tell" };

function luckText(s: Standing): string {
  if (s.closed < 10) return s.closed ? `${s.closed} rounds: too few to tell` : "no rounds yet";
  if (s.luck === null) return "—";
  if (s.luck < 0.05) return `a coin does this ${pc(s.luck)} of the time: looks like skill`;
  return `a coin does this ${pc(s.luck)} of the time: could be luck`;
}

function Call({ r }: { r: Round }) {
  return <b className={r.direction === "long" ? "pos" : "neg"}>{r.direction === "long" ? "▲" : "▼"} {r.symbol}</b>;
}

export default async function ScoreboardPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [cards, tracks, candidates, reviews, calibrated] = await Promise.all([store.allCards(), store.allTracks(), store.candidatesSince(3650), store.allReviews(), store.calibratedVersionIds()]);
  const termByCard = new Map(candidates.filter((c) => c.cardId).map((c) => [c.cardId!, c.term]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const ideas = await loadIdeas(cards, tracks);
  const rounds = ideas.map((i) => {
    const c = cardById.get(i.cardId)!;
    return toRound(i, playerOf(c.origin, termByCard.get(c.id)), typeof c.card.confidence === "number" ? c.card.confidence : null, calibrated.has(c.versionId));
  });
  const table = standings(rounds);
  const calib = calibration(rounds);
  const calibN = calib.reduce((a, b) => a + b.n, 0);
  const kinds = byKind(rounds);
  const active = PLAYERS.filter((p) => rounds.some((r) => r.player === p));
  const recent = rounds.filter((r) => r.closed && r.points !== null).sort((a, b) => (b.exitDate ?? "").localeCompare(a.exitDate ?? "")).slice(0, 15);
  const inPlay = rounds.filter((r) => !r.closed && r.points !== null).sort((a, b) => b.points! - a.points!);

  return (
    <>
      <h1>Scoreboard</h1>
      <section className="card notice small">
        Points are paper dollars beaten versus SPY on a ${STAKE.toLocaleString("en-US")} stake per call: a call that does 3.2% better than SPY scores +32, one that lags by 5% scores −50. <b>Banked</b> points come from closed calls; <b>in play</b> are open calls at the latest close and can still change.
        Every call ever tracked counts here, across versions; the formal pass/fail per version stays on <a href="/scoring">Scoring</a>. Paper only.
      </section>

      <section className="card">
        <h2>Leaderboard</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Player</th><th className="num">Banked</th><th className="num">In play</th><th className="num">Rounds won</th><th className="num">Hit rate</th><th>Luck check</th><th>Best · worst</th><th className="num">Calibration (Brier)</th></tr></thead>
            <tbody>
              {table.filter((s) => s.calls > 0).map((s, i) => (
                <tr key={s.player}>
                  <td>{i === 0 && s.banked > 0 ? "🏆 " : ""}<b>{PLAYER_LABEL[s.player]}</b><div className="small muted">{s.calls} calls · {s.closed} closed · {s.open} open</div></td>
                  <td className={`num ${cls(s.banked)}`}><b>{pts(s.banked)}</b></td>
                  <td className={`num ${cls(s.inPlay)}`}>{pts(s.inPlay)}</td>
                  <td className="num">{s.closed ? `${s.wins} / ${s.closed}` : "—"}</td>
                  <td className="num">{pc(s.hitRate)}</td>
                  <td className="small secondary">{luckText(s)}</td>
                  <td className="small">{s.best ? <><Call r={s.best} /> <span className={cls(s.best.points)}>{pts(s.best.points)}</span></> : "—"}{s.worst ? <> · <Call r={s.worst} /> <span className={cls(s.worst.points)}>{pts(s.worst.points)}</span></> : ""}</td>
                  <td className="num">{s.brier === null ? "—" : s.brier.toFixed(3)}<div className="small muted">{s.brierN ? `${s.brierN} rated` : ""}</div></td>
                </tr>
              ))}
              {!table.some((s) => s.calls > 0) && <tr><td colSpan={8} className="muted">No tracked calls yet. A call enters at the next open after its card, once the after-close job has run.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small secondary">Hit rate = closed calls that beat SPY. The luck check asks how often flipping a coin for each call would win at least as many rounds; under 5% starts to look like skill, and it needs at least 10 rounds to say anything. Brier: 0 is perfect, 0.25 is what you get by always saying 50%, higher is worse than that.</p>
      </section>

      <section className="card">
        <h2>Calibration: when a call said X%, did it win X% of the time?</h2>
        <p className="small secondary">Confidence is the model&apos;s stated chance that the call beats SPY over its holding period. The model sets it on every card, including the ones researched from your ideas. Only cards from versions that define it that way count ({calibN} closed so far). A well-calibrated player&apos;s two bars match; a longer &quot;said&quot; bar means overconfident.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Stated chance</th><th className="num">Calls</th><th>Said vs. actually won</th></tr></thead>
            <tbody>
              {calib.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td><td className="num">{b.n}</td>
                  <td>{b.n ? (
                    <div className="meters">
                      <div className="meter"><span className="meter-fill said" style={{ width: `${Math.round((b.said ?? 0) * 100)}%` }} /><span className="small">said {pc(b.said)}</span></div>
                      <div className="meter"><span className={`meter-fill ${b.hit !== null && b.said !== null && b.hit + 0.1 < b.said ? "over" : "won"}`} style={{ width: `${Math.round((b.hit ?? 0) * 100)}%` }} /><span className="small">won {pc(b.hit)}</span></div>
                    </div>
                  ) : <span className="muted small">no closed calls</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Where the edge is: rounds won by kind of call</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kind</th>{active.map((p) => <th key={p} className="num">{PLAYER_LABEL[p]}</th>)}</tr></thead>
            <tbody>
              {(["consumer", "platform", "second_order", "rerating", "event"] as Kind[]).map((k) => (
                <tr key={k}><td>{KIND_LABEL[k]}</td>{active.map((p) => {
                  const c = kinds[k]?.[p];
                  return <td key={p} className="num">{c ? <><span>{c.wins} / {c.closed}</span> <span className={`small ${cls(c.points)}`}>{pts(c.points)}</span></> : <span className="muted">—</span>}</td>;
                })}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small secondary">Wins / closed calls, and points. Lean into the rows that win, and give the rows that keep losing to someone else.</p>
      </section>

      <section className="card">
        <h2>Recent rounds</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Closed</th><th>Player</th><th>Call</th><th className="num">Points</th><th>What happened</th></tr></thead>
            <tbody>
              {recent.map((r) => {
                const rv = reviews.get(r.cardId);
                return (
                  <tr key={r.cardId}>
                    <td className="small">{r.exitDate}</td>
                    <td className="small">{PLAYER_LABEL[r.player]}</td>
                    <td><Call r={r} /> <span className="small secondary">{cardById.get(r.cardId)?.title}</span>{r.confidence !== null && r.calibrated && <span className="small muted"> · said {r.confidence}%</span>}</td>
                    <td className={`num ${cls(r.points)}`}><b>{pts(r.points)}</b></td>
                    <td className="small">{rv ? <><span className="tag">{VERDICT[rv.verdict] ?? rv.verdict}</span> {rv.summary}</> : <span className="muted">no post-catalyst check</span>}</td>
                  </tr>
                );
              })}
              {recent.length === 0 && <tr><td colSpan={5} className="muted">No closed rounds yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>In play</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Since</th><th>Player</th><th>Call</th><th className="num">Points now</th></tr></thead>
            <tbody>
              {inPlay.map((r) => (
                <tr key={r.cardId}><td className="small">{r.entryDate}</td><td className="small">{PLAYER_LABEL[r.player]}</td><td><Call r={r} /> <span className="small secondary">{cardById.get(r.cardId)?.title}</span></td><td className={`num ${cls(r.points)}`}>{pts(r.points)}</td></tr>
              ))}
              {inPlay.length === 0 && <tr><td colSpan={4} className="muted">Nothing open.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
