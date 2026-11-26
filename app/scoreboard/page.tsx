import SetupNotice from "@/components/SetupNotice";
import { KIND_LABEL, type Kind } from "@/config/scout";
import { hasDatabase } from "@/lib/db";
import { loadIdeas } from "@/lib/scout/ideas-load";
import { boardLines, byKind, byVerdict, calibration, PLAYER_LABEL, PLAYERS, playerOf, score, splitBy, STAKE, storiesOf, STORY_DAYS, STUDY_ONLY, toRound, verdictGroup, type Line, type Round, type SplitRow } from "@/lib/scout/scoreboard";
import { ruleRows } from "@/lib/scout/rule-books";
import type { RuleLine } from "@/lib/scout/rule-lines";
import { crowdingFor, STAGE_LABEL, timing } from "@/lib/scout/crowding";
import * as store from "@/lib/scout/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pts = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toLocaleString("en-US")}`);
const cls = (x: number | null | undefined) => (!x ? "" : x > 0 ? "pos" : "neg");
const pc = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

function luckText(s: { closed: number; luck: number | null }): string {
  if (s.closed < 10) return s.closed ? `${s.closed} closed: too few to tell` : "none closed yet";
  if (s.luck === null) return "—";
  if (s.luck < 0.05) return `a coin does this ${pc(s.luck)} of the time: looks like skill`;
  return `a coin does this ${pc(s.luck)} of the time: could be luck`;
}

function SplitTable({ title, rows }: { title: string; rows: SplitRow[] }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>{title}</th><th className="num">Calls</th><th className="num">Closed</th><th className="num">Won</th><th className="num">Hit rate</th><th className="num">Banked</th><th className="num">Per call</th></tr></thead>
      <tbody>
        {rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{r.calls}</td><td className="num">{r.closed}</td><td className="num">{r.wins}</td><td className="num">{pc(r.hitRate)}</td><td className={`num ${cls(r.banked)}`}>{pts(r.banked)}</td><td className={`num ${cls(r.avg)}`}>{pts(r.avg)}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={7} className="muted small">No calls with a reading yet.</td></tr>}
      </tbody>
    </table></div>
  );
}

function Call({ r }: { r: Round }) {
  return <b className={r.direction === "long" ? "pos" : "neg"}>{r.direction === "long" ? "▲" : "▼"} {r.symbol}</b>;
}

function LinesTable({ lines, empty }: { lines: Line[]; empty: string }) {
  const firstOf = new Set<string>();
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Player</th><th>Side</th><th className="num">Stories closed</th><th className="num">Hit rate</th><th className="num">Median</th><th className="num">Mean without best and worst</th><th className="num">Banked</th><th className="num">In play</th><th>Luck check</th><th>Best · worst</th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const first = !firstOf.has(l.player);
            firstOf.add(l.player);
            return (
              <tr key={`${l.player}${l.side}`}>
                <td>{first ? <b>{PLAYER_LABEL[l.player]}</b> : null}</td>
                <td className={l.side === "long" ? "pos" : "neg"}>{l.side === "long" ? "▲ longs" : "▼ shorts"}<div className="small muted">{l.stories} {l.stories === 1 ? "story" : "stories"}{l.calls > l.stories ? ` from ${l.calls} calls` : ""} · {l.open} open</div></td>
                <td className="num">{l.closed || "—"}</td>
                <td className="num">{l.closed ? <>{pc(l.hitRate)}<div className="small muted">{l.wins} of {l.closed}</div></> : "—"}</td>
                <td className={`num ${cls(l.median)}`}><b>{pts(l.median)}</b></td>
                <td className={`num ${cls(l.trimmed)}`}>{pts(l.trimmed)}</td>
                <td className={`num ${cls(l.banked)}`}>{l.closed ? pts(l.banked) : "—"}<div className="small muted">{l.closed ? `${pts(l.bankedSpy)} vs SPY` : ""}</div></td>
                <td className={`num ${cls(l.inPlay)}`}>{l.open ? pts(l.inPlay) : "—"}</td>
                <td className="small secondary">{luckText(l)}</td>
                <td className="small">{l.best ? <><Call r={l.best} /> <span className={cls(score(l.best))}>{pts(score(l.best))}</span></> : "—"}{l.worst ? <> · <Call r={l.worst} /> <span className={cls(score(l.worst))}>{pts(score(l.worst))}</span></> : ""}</td>
              </tr>
            );
          })}
          {lines.length === 0 && <tr><td colSpan={10} className="muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function RulesTable({ rows }: { rows: RuleLine[] }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Rule</th><th>Side</th><th className="num">Trades</th><th className="num">Closed</th><th className="num">Hit rate</th><th className="num">Median</th><th className="num">Mean without best and worst</th><th className="num">Banked</th><th className="num">In play</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.rule}>
            <td><b>{r.rule}</b><div className="small muted">{r.about}</div></td>
            <td className={r.side === "long" ? "pos" : "neg"}>{r.side === "long" ? "▲ long" : "▼ short"}</td>
            <td className="num">{r.trades}<div className="small muted">{r.open} open</div></td><td className="num">{r.closed || "—"}</td>
            <td className="num">{r.closed ? <>{pc(r.hitRate)}<div className="small muted">{r.wins} of {r.closed}</div></> : "—"}</td>
            <td className={`num ${cls(r.median)}`}><b>{pts(r.median)}</b></td><td className={`num ${cls(r.trimmed)}`}>{pts(r.trimmed)}</td>
            <td className={`num ${cls(r.banked)}`}>{r.closed ? pts(r.banked) : "—"}</td><td className={`num ${cls(r.inPlay)}`}>{r.open ? pts(r.inPlay) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export default async function ScoreboardPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const view = (await searchParams).v === "latest" ? "latest" : "all";
  const [cards, tracks, candidates, reviews, calibrated, versions] = await Promise.all([store.allCards(), store.allTracks(), store.candidatesSince(3650), store.allReviews(), store.calibratedVersionIds(), store.listVersions()]);
  const termByCard = new Map(candidates.filter((c) => c.cardId).map((c) => [c.cardId!, c.term]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const ideas = await loadIdeas(cards, tracks);
  const everyRound = ideas.map((i) => {
    const c = cardById.get(i.cardId)!;
    return toRound(i, playerOf(c.origin, termByCard.get(c.id)), typeof c.card.confidence === "number" ? c.card.confidence : null, calibrated.has(c.versionId), { versionId: c.versionId, term: termByCard.get(c.id) });
  });
  // One version at a time, or all of them. Nothing is frozen yet, so "all versions" is the default view.
  const latest = versions.at(-1) ?? null;
  const rounds = view === "latest" && latest ? everyRound.filter((r) => r.versionId === latest.id) : everyRound;
  const board = rounds.filter((r) => !r.study), study = rounds.filter((r) => r.study);
  const lines = boardLines(board), studyLines = boardLines(study);
  const stories = storiesOf(board.filter((r) => score(r) !== null));
  const verdicts = byVerdict(board, (id) => reviews.get(id)?.verdict);
  const calib = calibration(rounds);
  const calibN = calib.reduce((a, b) => a + b.n, 0);
  const kinds = byKind(rounds);
  // Crowding and analyst coverage when each card was written (cards from before these were measured have none).
  const crowd = await crowdingFor(rounds.map((r) => r.cardId)).catch(() => new Map());
  const entryOf = (r: Round) => crowd.get(r.cardId)?.entry ?? null;
  const byTiming = splitBy(rounds, (r) => { const t = timing(entryOf(r)?.stage ?? null); return t; }, ["early", "middle", "late"]);
  const byStage = splitBy(rounds, (r) => { const s = entryOf(r)?.stage; return s === null || s === undefined ? null : `${s} · ${STAGE_LABEL[s]}`; }, STAGE_LABEL.map((l, i) => `${i} · ${l}`));
  const byCoverage = splitBy(rounds, (r) => entryOf(r)?.parts.coverage?.band ?? null, ["low", "moderate", "high"]);
  // Shorts by whether the shares could be borrowed when entered (read from the day this was first recorded).
  const borrowOf = new Map(tracks.map((t) => [t.cardId, t.borrow ?? null]));
  const byBorrow = splitBy(rounds.filter((r) => r.direction === "short"), (r) => borrowOf.get(r.cardId) ?? null, ["easy", "hard", "not shortable"]);
  const measured = rounds.filter((r) => entryOf(r)).length;
  const active = PLAYERS.filter((p) => rounds.some((r) => r.player === p));
  const recent = rounds.filter((r) => r.closed && r.points !== null).sort((a, b) => (b.exitDate ?? "").localeCompare(a.exitDate ?? "")).slice(0, 40);
  const inPlay = rounds.filter((r) => !r.closed && r.points !== null).sort((a, b) => b.points! - a.points!);
  const rules = await ruleRows(cards, termByCard).catch(() => null);

  return (
    <>
      <h1>Scoreboard</h1>
      <section className="card notice small">
        The headline number is <b>points against the sector fund</b>: paper dollars beaten on a ${STAKE.toLocaleString("en-US")} stake against the fund of the call&apos;s own sector, so a chip stock is judged against chips, not the whole market (a call that does 3.2% better scores +32). <b>One result per story:</b> a player who calls the same stock the same way again within {STORY_DAYS} days is repeating one idea, and it counts once, at its first call. <b>Longs and shorts are on separate lines</b>, so a falling market cannot be read as skill. Read the median and the mean without the best and worst before the totals: one big winner can carry a total. Paper only.
        <div style={{ marginTop: 6 }}>
          View: <span className="filter-links"><a className={`chip ${view === "all" ? "active" : ""}`} href="/scoreboard">All versions</a> <a className={`chip ${view === "latest" ? "active" : ""}`} href="/scoreboard?v=latest">Latest version only{latest ? ` (v${latest.id}, since ${latest.createdAt.slice(0, 10)})` : ""}</a></span>
          <span className="muted"> · {versions.length} versions so far and none is frozen yet, so all versions is the default; the formal pass/fail per version is on <a href="/scoring">Scoring</a>.</span>
        </div>
      </section>

      {tracks.some((t) => t.priceCheck) && (
        <section className="card small warn">
          <b>Price unverified, left out of the points:</b> {tracks.filter((t) => t.priceCheck).map((t, i) => <span key={t.cardId}>{i ? "; " : ""}<a href={`/cards/${t.cardId}`}>card #{t.cardId}</a> ({t.priceCheck})</span>)}. A recorded entry has to sit inside the range the stock traded in that day, and a close more than 40% from the one before it has to agree with the whole market&apos;s close; these calls are &quot;price unverified&quot; until they do.
        </section>
      )}
      {tracks.some((t) => (t.splitFactor ?? 1) !== 1) && (
        <p className="small muted">Adjusted for stock splits since entry: {tracks.filter((t) => (t.splitFactor ?? 1) !== 1).map((t) => `${t.symbol} (card #${t.cardId}, ×${t.splitFactor})`).join(", ")}. The recorded entry is kept; returns use split-adjusted prices.</p>
      )}

      <section className="card">
        <h2>Leaderboard</h2>
        <p className="small secondary">{stories.length} stories from {board.length} calls{view === "latest" ? " in the latest version" : ""}. Players are ordered by their closed points, longs and shorts together.</p>
        <LinesTable lines={lines} empty="No tracked calls yet. A call enters at the live price when the market is open, else at the next open." />
        <p className="small secondary">Points are against each call&apos;s sector fund (against SPY for the few cards with no sector fund price); the small figure under Banked is the same stories against SPY. Hit rate = closed stories that beat their sector fund. The luck check asks how often a coin flipped once per story would win at least as many; under 5% starts to look like skill, and it needs at least 10 closed stories to say anything.</p>
      </section>

      <section className="card" id="rules">
        <h2>Rules, with no model deciding</h2>
        <p className="small secondary">Each rule takes every trade its condition gives, with no AI choosing. These are what could one day be traded by fixed rules, so each has its own line. Points here are against SPY (these books keep no sector fund) and each trade counts once.</p>
        {rules ? <RulesTable rows={rules.lines} /> : <p className="small muted">The rule books could not be read just now.</p>}
        {rules && (
          <>
            <h3 style={{ marginTop: "1rem" }}>Down drift: the model&apos;s picks against the setups it passed on</h3>
            <p className="small secondary">Every Drift setup is shorted by the rule the moment it lists. Some of them the model also wrote a card on (its picks); the rest it passed on. Both groups are measured the same way, from the rule&apos;s own entry. If the picks do no better than the passes, the model&apos;s judgment adds nothing to the plain rule here. Too few closed trades to say anything yet: the first close on {rules.firstClose ?? "a date not set yet"}.</p>
            <RulesTable rows={rules.picks} />
          </>
        )}
      </section>

      <section className="card" id="verdicts">
        <h2>Did the thesis play out, and did the call make money?</h2>
        <p className="small secondary">The day after a card&apos;s catalyst, the scout reads what happened and gives a verdict on the thesis. Points and the verdict can disagree: a short that made money while its thesis did not play out was the market, not the idea. Closed stories on the leaderboard, by verdict.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Thesis</th><th className="num">Closed stories</th><th className="num">Beat the sector fund</th><th className="num">Hit rate</th><th className="num">Median points</th></tr></thead>
          <tbody>{verdicts.map((v) => <tr key={v.verdict}><td>{v.verdict}</td><td className="num">{v.n}</td><td className="num">{v.n ? `${v.wins} of ${v.n}` : "—"}</td><td className="num">{pc(v.hitRate)}</td><td className={`num ${cls(v.median)}`}>{pts(v.median)}</td></tr>)}</tbody>
        </table></div>
        <p className="small muted">&quot;Cannot tell&quot; is a mixed result or a check made too early. &quot;No check yet&quot; means no post-catalyst read was made (a card with no dated catalyst closes at its time limit only).</p>
      </section>

      {studyLines.length > 0 && (
        <section className="card" id="study">
          <h2>Study only, off the leaderboard for now</h2>
          <p className="small secondary">These desks had a flaw in how their calls were made, so their results are kept apart until the desk has results under the fixed rule: rumors ({STUDY_ONLY.scout_rumors}), themes ({STUDY_ONLY.scout_themes}), and Congress clusters (clusters were built from small trades reported months late). The calls stay tracked and are never deleted.</p>
          <LinesTable lines={studyLines} empty="No study-only calls." />
        </section>
      )}

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

      <section className="card" id="crowding">
        <h2>Does being early help? Results by crowding and analyst coverage when the card was written</h2>
        <p className="small secondary">The research behind it says edges live where attention is scarce: calls made while a stock is early (crowding stage 0–1) and thinly covered should do better than late, well-covered ones. These are rules of thumb until our own paper results agree. {measured} of {rounds.length} calls have a reading at entry (cards from before Nov 21, 2026 have none; they are never back-filled).</p>
        <SplitTable title="Timing" rows={byTiming} />
        <SplitTable title="Crowding stage" rows={byStage} />
        <SplitTable title="Analyst coverage" rows={byCoverage} />
        <h3 style={{ marginTop: "1rem" }}>Shorts by whether the shares could be borrowed when entered</h3>
        <p className="small secondary">A paper short ignores borrow. From November 26, 2026 each new short records the broker&apos;s reading on its entry day: on the easy-to-borrow list, shortable but hard to borrow (a fee, or no fill), or not shortable. Older shorts have no reading and are left out. If the money is in the hard-to-borrow rows, it is not money a real account could have made.</p>
        <SplitTable title="Borrow at entry" rows={byBorrow} />
      </section>

      <section className="card">
        <h2>Recent closed calls, with the thesis verdict</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Closed</th><th>Player</th><th>Call</th><th className="num">vs SPY</th><th className="num">vs sector fund</th><th>Thesis</th></tr></thead>
            <tbody>
              {recent.map((r) => {
                const rv = reviews.get(r.cardId);
                return (
                  <tr key={r.cardId}>
                    <td className="small">{r.exitDate}</td>
                    <td className="small">{PLAYER_LABEL[r.player]}</td>
                    <td><Call r={r} /> <span className="small secondary">{cardById.get(r.cardId)?.title}</span>{r.confidence !== null && r.calibrated && <span className="small muted"> · said {r.confidence}%</span>}</td>
                    <td className={`num ${cls(r.points)}`}><b>{pts(r.points)}</b></td>
                    <td className={`num ${cls(r.sectorPoints)}`}>{pts(r.sectorPoints)}</td>
                    <td className="small"><span className={`tag ${verdictGroup(rv?.verdict) === "played out" ? "ok" : verdictGroup(rv?.verdict) === "did not play out" ? "error" : ""}`}>{verdictGroup(rv?.verdict)}</span> {rv ? rv.summary : <span className="muted">no post-catalyst read was made</span>}</td>
                  </tr>
                );
              })}
              {recent.length === 0 && <tr><td colSpan={6} className="muted">No closed rounds yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>In play</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Since</th><th>Player</th><th>Call</th><th className="num">Points now</th><th className="num">vs sector</th></tr></thead>
            <tbody>
              {inPlay.map((r) => (
                <tr key={r.cardId}><td className="small">{r.entryDate}</td><td className="small">{PLAYER_LABEL[r.player]}</td><td><Call r={r} /> <span className="small secondary">{cardById.get(r.cardId)?.title}</span></td><td className={`num ${cls(r.points)}`}>{pts(r.points)}</td><td className={`num ${cls(r.sectorPoints)}`}>{pts(r.sectorPoints)}</td></tr>
              ))}
              {inPlay.length === 0 && <tr><td colSpan={5} className="muted">Nothing open.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
