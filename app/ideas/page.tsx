import CardActions from "@/components/CardActions";
import CardView from "@/components/CardView";
import { CollapseAll } from "@/components/CardCollapse";
import Pager, { FilterLinks, hrefWith, paginate } from "@/components/Pager";
import SetupNotice from "@/components/SetupNotice";
import TickerSearch from "@/components/TickerSearch";
import { hasDatabase } from "@/lib/db";
import { opposingCalls } from "@/lib/scout/calendar";
import { repeatCards } from "@/lib/scout/dedupe";
import { PLAYER_LABEL, PLAYERS, playerOf, type Player } from "@/lib/scout/scoreboard";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";
import { toEt } from "@/lib/time";
import RememberFilters from "@/components/RememberFilters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_RANK: Record<string, number> = { promoted: 0, late: 1, not_promoted: 2 };
const SORTS = [{ value: "best", label: "Best first" }, { value: "newest", label: "Newest" }, { value: "confidence", label: "Highest confidence" }, { value: "catalyst", label: "Catalyst soonest" }];
const CONFS = [50, 60, 70, 80];
const PAGE = 10;

/** Where a card came from, in words: the desk or person, and the story / document / signal behind it. */
function fromLine(player: Player, term: string): string {
  const what = term.replace(/^(story|inbox|stream host|stream agent|filing|insider|options|congress|insider\+congress|truth): /, "").replace(/ → .*$/, "");
  return `${PLAYER_LABEL[player]}${what && what !== term || player === "scout_trend" || player === "you" ? ` · ${what}` : ""}`;
}

type SP = { days?: string; source?: string; status?: string; sort?: string; conf?: string; page?: string; card?: string };

export default async function IdeasPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = [7, 30, 90, 365].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const source = (PLAYERS as readonly string[]).includes(sp.source ?? "") ? (sp.source as Player) : "";
  const status = sp.status && sp.status in STATUS_RANK ? sp.status : "";
  const sort = SORTS.some((s) => s.value === sp.sort) ? sp.sort! : "best";
  const conf = CONFS.includes(Number(sp.conf)) ? Number(sp.conf) : 0;
  const params: Record<string, string | undefined> = { days: days === 7 ? undefined : String(days), source: source || undefined, status: status || undefined, sort: sort === "best" ? undefined : sort, conf: conf ? String(conf) : undefined, page: sp.page };

  const [cards, candidates, tracks, fb, recent] = await Promise.all([store.cardsSince(days), store.candidatesSince(days), store.allTracks(), store.latestFeedback(), store.cardsSince(120)]);
  const reviews = await store.allReviews();
  const opp = opposingCalls(recent, tracks);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const termOf = new Map(candidates.filter((c) => c.cardId !== null).map((c) => [c.cardId!, c.term]));
  const playerFor = (c: store.StoredCard) => playerOf(c.origin, termOf.get(c.id));
  // A later card that repeats an earlier call by the same source is folded under the first one (and scored once).
  const repeats = repeatCards(cards, termOf);
  const angles = new Map<number, number[]>();
  for (const [dup, first] of repeats) angles.set(first, [...(angles.get(first) ?? []), dup]);
  const today = toEt(new Date()).date;
  const sw = swingConfigured();

  // One list of every card in the window: filtered by source and status, sorted, 10 a page.
  const wantedId = Number(sp.card);
  const bySource = cards.filter((c) => (!repeats.has(c.id) || c.id === wantedId) && (!source || playerFor(c) === source));
  const byConf = bySource.filter((c) => c.card.confidence >= conf);
  const rows = byConf.filter((c) => !status || c.status === status).sort((a, b) =>
    sort === "newest" ? b.createdAt.localeCompare(a.createdAt)
      : sort === "confidence" ? b.card.confidence - a.card.confidence || b.rankScore - a.rankScore
      : sort === "catalyst" ? (a.catalystDate && a.catalystDate >= today ? a.catalystDate : "9999").localeCompare(b.catalystDate && b.catalystDate >= today ? b.catalystDate : "9999") || b.rankScore - a.rankScore
        : STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.rankScore - a.rankScore || b.createdAt.localeCompare(a.createdAt));
  const wanted = Number(sp.card);
  const at = wanted ? rows.findIndex((c) => c.id === wanted) : -1;
  const page = paginate(rows, at >= 0 ? Math.floor(at / PAGE) + 1 : Number(sp.page ?? 1), PAGE);

  const sourceCounts = new Map<string, number>();
  const shownCards = cards.filter((c) => !repeats.has(c.id));
  for (const c of shownCards) sourceCounts.set(playerFor(c), (sourceCounts.get(playerFor(c)) ?? 0) + 1);
  const statusCount = (v: string) => byConf.filter((c) => !v || c.status === v).length;
  const confCount = (n: number) => bySource.filter((c) => (!status || c.status === status) && c.card.confidence >= n).length;

  return (
    <>
      <h1>Ideas</h1>
      <RememberFilters keys={["days", "sort", "status", "source", "conf"]} />
      <TickerSearch />
      <details className="card notice small section">
        <summary><b>How this page works</b></summary>
        Every thesis card from every desk in one list: the trend desk (watch-list and discovery), the story desk (breaking news), filings, insiders and Congress, unusual options positions, Trump&apos;s posts, your bot&apos;s inbox, and what you noticed yourself.
        &quot;Best first&quot; puts promoted cards first, then late, then not promoted, each by novelty × materiality. Every promoted and late card is tracked on paper from the next open after the card to the earlier of the day after its catalyst, its time limit or the invalidation being met, whether or not you send it to the Swing ideas log.
        Late cards (already up a lot or already everywhere in the news) are logged and tracked so the lateness gate can be checked. Market panels, upcoming catalysts and the desks' reports (including everything considered and rejected) are on Home.
        {!sw && <div className="muted" style={{ marginTop: 6 }}>Sending to the Swing ideas log is not configured yet (SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD).</div>}
      </details>
      <span id="cards" />
      <div className="toolbar">
        <FilterLinks params={params} name="days" value={days === 7 ? "" : String(days)} reset={["page", "card"]} options={[{ value: "", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }]} />
        <FilterLinks params={params} name="sort" value={sort === "best" ? "" : sort} reset={["page", "card"]} options={SORTS.map((s) => ({ value: s.value === "best" ? "" : s.value, label: s.label }))} />
      </div>
      <div className="toolbar">
        <FilterLinks params={params} name="status" value={status} reset={["page", "card"]} options={[{ value: "", label: "Any status", count: statusCount("") }, { value: "promoted", label: "Promoted", count: statusCount("promoted") }, { value: "late", label: "Late", count: statusCount("late") }, { value: "not_promoted", label: "Not promoted", count: statusCount("not_promoted") }]} />
      </div>
      <div className="toolbar">
        <FilterLinks params={params} name="conf" value={conf ? String(conf) : ""} reset={["page", "card"]} options={[{ value: "", label: "Any confidence", count: confCount(0) }, ...CONFS.map((n) => ({ value: String(n), label: `Confidence ${n}+`, count: confCount(n) }))]} />
      </div>
      <div className="toolbar">
        <FilterLinks params={params} name="source" value={source} reset={["page", "card"]} options={[{ value: "", label: "All sources", count: shownCards.length }, ...PLAYERS.filter((p) => sourceCounts.get(p)).map((p) => ({ value: p, label: PLAYER_LABEL[p].replace(/^Scout · /, ""), count: sourceCounts.get(p) }))]} />
      </div>
      <div className="toolbar" style={{ justifyContent: "space-between" }}><CollapseAll /><Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="cards" hash="#cards" /></div>
      {page.items.map((c) => {
        const tr = t.get(c.id) ?? null;
        return (
          <div key={c.id}>
            <div className="small muted from-line">From: {fromLine(playerFor(c), termOf.get(c.id) ?? "")}
              {angles.get(c.id)?.length ? <> · also {angles.get(c.id)!.map((id, j) => <span key={id}>{j ? ", " : ""}<a href={hrefWith(params, { card: String(id), page: undefined }, `#card-${id}`)}>card #{id}</a></span>)} <span title="Another angle on the same call from the same source within 14 days: kept on file, scored once">(same call, scored once)</span></> : null}
              {repeats.has(c.id) ? <> · <span className="warn">repeat of <a href={hrefWith(params, { card: String(repeats.get(c.id)), page: undefined }, `#card-${repeats.get(c.id)}`)}>card #{repeats.get(c.id)}</a>: not scored</span></> : null}
            </div>
            <CardView c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} excluded={!!tr?.excluded} />} />
          </div>
        );
      })}
      {page.total === 0 && <section className="card"><p className="muted">{cards.length ? "No cards match these filters." : `No cards in the last ${days} days. The scans run at midday on weekdays and hourly for stories.`}</p></section>}
      <Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="cards" hash="#cards" />

    </>
  );
}
