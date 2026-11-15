import CardActions from "@/components/CardActions";
import CardView from "@/components/CardView";
import Pager, { FilterLinks, hrefWith, paginate } from "@/components/Pager";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { opposingCalls, upcomingCatalysts } from "@/lib/scout/calendar";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";
import { fmtEt, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OUTCOMES = [
  { value: "", label: "All" }, { value: "promoted", label: "Promoted" }, { value: "late", label: "Late" }, { value: "not_promoted", label: "Not promoted" },
  { value: "rejected", label: "Rejected" }, { value: "duplicate", label: "Duplicate" }, { value: "error", label: "Error" },
];
/** Pure: one word for what happened to a candidate. */
function outcomeOf(c: { outcome: string; reason: string | null }): string {
  if (c.outcome === "card") return c.reason ?? "card";
  if (c.outcome === "rejected" && /^duplicate/.test(c.reason ?? "")) return "duplicate";
  return c.outcome;
}
const LOG_PAGE = 50;
const CARD_PAGE = 10;

export default async function CandidatesPage({ searchParams }: { searchParams: Promise<{ days?: string; card?: string; outcome?: string; origin?: string; lpage?: string; page?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = Math.min(90, Math.max(1, Number(sp.days ?? 7) || 7));
  const outcome = OUTCOMES.some((o) => o.value === sp.outcome) ? sp.outcome! : "";
  const origin = sp.origin === "scout" || sp.origin === "human" ? sp.origin : "";
  const params = { days: sp.days, outcome: outcome || undefined, origin: origin || undefined, lpage: sp.lpage, page: sp.page };
  const [candidates, cards, tracks, runs, fb, recent] = await Promise.all([store.candidatesSince(days), store.cardsSince(days), store.allTracks(), store.recentRuns(10), store.latestFeedback(), store.cardsSince(120)]);
  const opp = opposingCalls(recent, tracks);
  const reviews = await store.allReviews();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const sw = swingConfigured();
  const running = runs.find((r) => r.action === "daily" && r.status === "running");
  const lastDaily = runs.find((r) => r.action === "daily" && r.status !== "running");
  // Log: filtered by outcome and origin, 50 a page. Cards: the same filters where they apply, 10 a page.
  const byOrigin = candidates.filter((c) => !origin || c.origin === origin);
  const logRows = byOrigin.filter((c) => !outcome || outcomeOf(c) === outcome);
  const log = paginate(logRows, Number(sp.lpage ?? 1), LOG_PAGE);
  const counts = new Map<string, number>();
  for (const c of byOrigin) counts.set(outcomeOf(c), (counts.get(outcomeOf(c)) ?? 0) + 1);
  const cardStatus = ["promoted", "late", "not_promoted"].includes(outcome) ? outcome : "";
  const cardRows = cards.filter((c) => (!origin || c.origin === origin) && (!cardStatus || c.status === cardStatus));
  const wanted = Number(sp.card);
  const at = wanted ? cardRows.findIndex((c) => c.id === wanted) : -1;
  const cardPage = paginate(cardRows, at >= 0 ? Math.floor(at / CARD_PAGE) + 1 : Number(sp.page ?? 1), CARD_PAGE);
  const cardHref = (id: number) => hrefWith(params, { card: String(id), page: undefined }, `#card-${id}`);
  const measured = (lastDaily?.detail as { measured?: Array<{ term: string; kind: string; sources: number; accelerating: number; score: number; candidate: boolean; cooldown: boolean }>; risingQueries?: Array<{ title: string; traffic: string }>; stoppedEarly?: string | null; discovery?: { headlinesRead: number; read: string | null; proposed: Array<{ term: string; kind: string; tickers: string[]; why: string }>; problems: string[]; error: string | null } | null } | null) ?? null;
  return (
    <>
      <h1>Candidates</h1>
      <p className="small secondary">Everything the scout logged in the last {days} days, newest first, including what it rejected and why. <a href={hrefWith(params, { days: "7", lpage: undefined, page: undefined })}>7d</a> · <a href={hrefWith(params, { days: "30", lpage: undefined, page: undefined })}>30d</a> · <a href={hrefWith(params, { days: "90", lpage: undefined, page: undefined })}>90d</a></p>
      {running && <p className="small warn">A scan started at {running.startedAt.replace("T", " ").slice(0, 16)}Z is still running; refresh in a few minutes.</p>}
      {lastDaily && (
        <details className="card section">
          <summary><h2>Last scan · {toEt(new Date(lastDaily.startedAt)).date} · {lastDaily.status}{lastDaily.error ? ` · ${lastDaily.error}` : ""}</h2> <span className="small muted">(watch-list measurements and discovery; click to open)</span></summary>
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
        </details>
      )}
      <details className="card section" open id="log">
        <summary><h2>Log</h2> <span className="small muted">{logRows.length} of {candidates.length} · click to collapse</span></summary>
        <div className="toolbar">
          <FilterLinks params={params} name="outcome" value={outcome} reset={["lpage", "page"]} options={OUTCOMES.map((o) => ({ ...o, count: o.value ? counts.get(o.value) ?? 0 : byOrigin.length }))} />
          <FilterLinks params={params} name="origin" value={origin} reset={["lpage", "page"]} options={[{ value: "", label: "Any origin" }, { value: "scout", label: "Scout" }, { value: "human", label: "Human" }]} />
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Origin</th><th>Term</th><th>Outcome</th><th>Why</th></tr></thead>
            <tbody>
              {log.items.map((c) => (
                <tr key={c.id}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtEt(c.createdAt)}</td>
                  <td className="small">{c.origin}</td>
                  <td>{c.term}{c.observation ? <div className="small muted">“{c.observation}”</div> : null}</td>
                  <td><span className={`tag ${c.outcome === "card" ? (c.reason ?? "") : c.outcome}`}>{c.outcome === "card" ? c.reason?.replace("_", " ") : c.outcome}</span>{c.cardId ? <a className="small" href={cardHref(c.cardId)}>#{c.cardId}</a> : null}</td>
                  <td className="small secondary">{c.outcome === "card" ? byId.get(c.cardId!)?.gateNotes.join(" · ") : c.reason}{c.trigger?.length ? <div className="muted">flagged by: {c.trigger.map((s) => `${s.source} ${s.changeVs12m === null ? "" : `${s.changeVs12m >= 0 ? "+" : ""}${Math.round(s.changeVs12m * 100)}%`}`).join(", ")}</div> : null}</td>
                </tr>
              ))}
              {log.items.length === 0 && <tr><td colSpan={5} className="muted">Nothing matches in this window.</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager params={params} name="lpage" page={log.page} pages={log.pages} total={log.total} label="logged" hash="#log" />
      </details>
      <h2 id="cards">Cards {cardStatus || origin ? <span className="small muted">({[cardStatus.replace("_", " "), origin].filter(Boolean).join(", ")})</span> : null}</h2>
      <Pager params={params} name="page" page={cardPage.page} pages={cardPage.pages} total={cardPage.total} label="cards" hash="#cards" />
      {cardPage.items.map((c) => {
        const tr = t.get(c.id) ?? null;
        return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} excluded={!!tr?.excluded} />} />;
      })}
      <Pager params={params} name="page" page={cardPage.page} pages={cardPage.pages} total={cardPage.total} label="cards" hash="#cards" />
    </>
  );
}
