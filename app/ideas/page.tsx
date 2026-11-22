import CardActions from "@/components/CardActions";
import { originLink } from "@/lib/scout/origin-tag";
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
import { marketDataFromEnv } from "@/lib/alpaca";
import { isPennyShort } from "@/lib/scout/card";
import { profilesForCards, shortPct, SIZE_KEYS, sizeKey } from "@/lib/scout/card-profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_RANK: Record<string, number> = { promoted: 0, late: 1, not_promoted: 2 };
const SORTS = [{ value: "best", label: "Best first" }, { value: "newest", label: "Newest" }, { value: "confidence", label: "Highest confidence" }, { value: "catalyst", label: "Catalyst soonest" }];
/** Filter groups that do not overlap, so their counts add up to the total. */
const CONF_BANDS = [
  { key: "lt50", label: "Confidence under 50", lo: 0, hi: 50 }, { key: "50", label: "50–59", lo: 50, hi: 60 }, { key: "60", label: "60–69", lo: 60, hi: 70 },
  { key: "70", label: "70–79", lo: 70, hi: 80 }, { key: "80", label: "80+", lo: 80, hi: Infinity },
] as const;
const SHORT_BANDS = [
  { key: "lt5", label: "Short under 5% of float", lo: 0, hi: 5 }, { key: "5", label: "5–10%", lo: 5, hi: 10 }, { key: "10", label: "10–20%", lo: 10, hi: 20 },
  { key: "20", label: "20%+", lo: 20, hi: Infinity }, { key: "unknown", label: "short interest unknown", lo: NaN, hi: NaN },
] as const;
/** The card's own scores as filters (in % as shown on the card): three bands each, so the counts add up. */
const SCORE_FILTERS = [
  { param: "nov", label: "novelty", get: (c: store.StoredCard) => c.card.scores.novelty * 10 },
  { param: "mat", label: "materiality", get: (c: store.StoredCard) => c.card.scores.materiality * 10 },
  { param: "evi", label: "evidence", get: (c: store.StoredCard) => c.card.scores.breadth_of_evidence * 10 },
  { param: "early", label: "early", get: (c: store.StoredCard) => c.card.scores.lateness * 10 },
  { param: "rank", label: "rank", get: (c: store.StoredCard) => c.rankScore },
] as const;
type ScoreParam = (typeof SCORE_FILTERS)[number]["param"];
const SCORE_BANDS = (param: ScoreParam) => (param === "rank"
  ? [{ key: "lt30", label: "under 30%", lo: 0, hi: 30 }, { key: "30", label: "30–49%", lo: 30, hi: 50 }, { key: "50", label: "50%+", lo: 50, hi: Infinity }]
  : [{ key: "lt50", label: "under 50%", lo: 0, hi: 50 }, { key: "50", label: "50–69%", lo: 50, hi: 70 }, { key: "70", label: "70%+", lo: 70, hi: Infinity }]);
const PAGE = 10;

/** Where a card came from, in words: the desk or person, and the story / document / signal behind it. */
/** The "From:" line: where the idea came from (and a link to it), what it was, and whose score it counts for. */
function fromLine(player: Player, term: string, src: { tag: string; url: string } | null): React.ReactNode {
  const what = term.replace(/^(story|inbox|stream host|stream agent|filing|insider|options|congress|insider\+congress|truth|dots|court|theme|rumor|investigate|drift|site): /, "").replace(/ → .*$/, "");
  return <>{src ? <a href={src.url}>{src.tag}</a> : PLAYER_LABEL[player]}{what ? ` · ${what}` : ""} <span className="muted">(scored as {PLAYER_LABEL[player]})</span></>;
}

type SP = { days?: string; source?: string; status?: string; sort?: string; conf?: string; cap?: string; short?: string; dir?: string; penny?: string; page?: string; card?: string } & Partial<Record<ScoreParam, string>>;

export default async function IdeasPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = [7, 30, 90, 365].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const source = (PLAYERS as readonly string[]).includes(sp.source ?? "") ? (sp.source as Player) : "";
  const status = sp.status && sp.status in STATUS_RANK ? sp.status : "";
  const sort = SORTS.some((s) => s.value === sp.sort) ? sp.sort! : "best";
  const conf = CONF_BANDS.some((b) => b.key === sp.conf) ? sp.conf! : "";
  const cap = SIZE_KEYS.some((s) => s.key === sp.cap) || sp.cap === "unknown" ? sp.cap! : "";
  const dir = sp.dir === "long" || sp.dir === "short" ? sp.dir : "";
  const shortBand = SHORT_BANDS.some((b) => b.key === sp.short) ? sp.short! : "";
  const scoreSel = Object.fromEntries(SCORE_FILTERS.map((f) => [f.param, SCORE_BANDS(f.param).some((b) => b.key === sp[f.param]) ? sp[f.param]! : ""])) as Record<ScoreParam, string>;
  const params: Record<string, string | undefined> = { days: days === 7 ? undefined : String(days), source: source || undefined, status: status || undefined, sort: sort === "best" ? undefined : sort, conf: conf || undefined, cap: cap || undefined, short: shortBand || undefined, dir: dir || undefined, ...Object.fromEntries(SCORE_FILTERS.map((f) => [f.param, scoreSel[f.param] || undefined])), page: sp.page };

  const [cards, candidates, tracks, fb, recent] = await Promise.all([store.cardsSince(days), store.candidatesSince(days), store.allTracks(), store.latestFeedback(), store.cardsSince(120)]);
  const [reviews, profiles] = await Promise.all([store.allReviews(), profilesForCards(cards)]);
  // No shorts under $5: such cards stay in the log but are hidden unless asked for (older cards checked at today's price).
  const showPenny = sp.penny === "1";
  const shortSyms = [...new Set(cards.filter((c) => c.direction === "short").map((c) => c.primaryTicker))];
  const shortPx = shortSyms.length ? await (marketDataFromEnv()?.getSnapshots?.(shortSyms) ?? Promise.resolve({} as Record<string, { price: number }>)).catch(() => ({} as Record<string, { price: number }>)) : {};
  const penny = new Set(cards.filter((c) => isPennyShort(c, shortPx[c.primaryTicker]?.price)).map((c) => c.id));
  // Size and short-interest filters: the card's market cap and % of float short (frozen when written, else today's).
  const capOk = (c: store.StoredCard, k = cap) => !k || (sizeKey(profiles.get(c.id)?.marketCap) ?? "unknown") === k;
  const shortOk = (c: store.StoredCard, k = shortBand) => {
    if (!k) return true;
    const v = shortPct(profiles.get(c.id));
    if (k === "unknown") return v === null;
    const b = SHORT_BANDS.find((x) => x.key === k)!;
    return v !== null && v >= b.lo && v < b.hi;
  };
  const confOk = (c: store.StoredCard, k = conf) => {
    if (!k) return true;
    const b = CONF_BANDS.find((x) => x.key === k)!;
    return c.card.confidence >= b.lo && c.card.confidence < b.hi;
  };
  const dirOk = (c: store.StoredCard, d = dir) => !d || c.direction === d;
  /** Every score filter, with one of them replaced (for that filter's own counts). */
  const scoresOk = (c: store.StoredCard, over?: { param: ScoreParam; key: string }) => SCORE_FILTERS.every((f) => {
    const k = over && over.param === f.param ? over.key : scoreSel[f.param];
    if (!k) return true;
    const b = SCORE_BANDS(f.param).find((x) => x.key === k)!;
    const v = f.get(c);
    return v >= b.lo && v < b.hi;
  });
  const opp = opposingCalls(recent, tracks);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const termOf = new Map(candidates.filter((c) => c.cardId !== null).map((c) => [c.cardId!, c.term]));
  const candOf = new Map(candidates.filter((c) => c.cardId !== null).map((c) => [c.cardId!, c]));
  const { dotsIdeaFor, recentDotsRuns } = await import("@/lib/scout/dots");
  const dotRuns = await recentDotsRuns().catch(() => []);
  const srcOf = (c: store.StoredCard) => {
    const x = candOf.get(c.id);
    const o = originLink(c.origin, x?.term, x?.observation, x ? { label: x.sourceLabel, url: x.sourceUrl } : null);
    // Sent from Dots before the buttons recorded their page: the idea on the same stock and side just before.
    if (c.origin === "human" && !x?.sourceLabel && /^(Your note|Your image)$/.test(o.tag)) { const d = dotsIdeaFor(dotRuns, c.primaryTicker, c.direction, c.createdAt); if (d) return { ...o, tag: "Dots", url: d.url }; }
    return o;
  };
  const playerFor = (c: store.StoredCard) => playerOf(c.origin, termOf.get(c.id));
  // A later card that repeats an earlier call by the same source is folded under the first one (and scored once).
  const repeats = repeatCards(cards, termOf);
  const angles = new Map<number, number[]>();
  for (const [dup, first] of repeats) angles.set(first, [...(angles.get(first) ?? []), dup]);
  const today = toEt(new Date()).date;
  const sw = swingConfigured();

  // One list of every card in the window: filtered by source and status, sorted, 10 a page.
  const wantedId = Number(sp.card);
  const bySource = cards.filter((c) => (!repeats.has(c.id) || c.id === wantedId) && (!source || playerFor(c) === source) && (showPenny || !penny.has(c.id) || c.id === wantedId));
  const byConf = bySource.filter((c) => confOk(c) && capOk(c) && shortOk(c) && dirOk(c) && scoresOk(c));
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
  const confCount = (n: string) => bySource.filter((c) => (!status || c.status === status) && confOk(c, n) && capOk(c) && shortOk(c) && dirOk(c) && scoresOk(c)).length;
  const capCount = (k: string) => bySource.filter((c) => (!status || c.status === status) && confOk(c) && capOk(c, k) && shortOk(c) && dirOk(c) && scoresOk(c)).length;
  const shortCount = (m: string) => bySource.filter((c) => (!status || c.status === status) && confOk(c) && capOk(c) && shortOk(c, m) && dirOk(c) && scoresOk(c)).length;
  const dirCount = (d: string) => bySource.filter((c) => (!status || c.status === status) && confOk(c) && capOk(c) && shortOk(c) && dirOk(c, d) && scoresOk(c)).length;
  const scoreCount = (param: ScoreParam, key: string) => bySource.filter((c) => (!status || c.status === status) && confOk(c) && capOk(c) && shortOk(c) && dirOk(c) && scoresOk(c, { param, key })).length;

  return (
    <>
      <h1>Ideas</h1>
      <RememberFilters keys={["days", "sort", "status", "source", "conf", "cap", "short", "dir", ...SCORE_FILTERS.map((f) => f.param)]} />
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
        <FilterLinks params={params} name="dir" value={dir} reset={["page", "card"]} options={[{ value: "", label: "Long and short", count: dirCount("") }, { value: "long", label: "▲ Long", count: dirCount("long") }, { value: "short", label: "▼ Short", count: dirCount("short") }]} />
        <FilterLinks params={params} name="status" value={status} reset={["page", "card"]} options={[{ value: "", label: "Any status", count: statusCount("") }, { value: "promoted", label: "Promoted", count: statusCount("promoted") }, { value: "late", label: "Late", count: statusCount("late") }, { value: "not_promoted", label: "Not promoted", count: statusCount("not_promoted") }]} />
      </div>
      <div className="toolbar">
        <FilterLinks params={params} name="conf" value={conf} reset={["page", "card"]} options={[{ value: "", label: "Any confidence", count: confCount("") }, ...CONF_BANDS.map((b) => ({ value: b.key, label: b.label, count: confCount(b.key) }))]} />
      </div>
      <details className="score-filters" open={SCORE_FILTERS.some((f) => scoreSel[f.param])}>
        <summary className="small">Scores: novelty, materiality, evidence, early, rank{SCORE_FILTERS.some((f) => scoreSel[f.param]) ? ` (${SCORE_FILTERS.filter((f) => scoreSel[f.param]).length} on)` : ""}</summary>
        {SCORE_FILTERS.map((f) => (
          <div className="toolbar" key={f.param}>
            <FilterLinks params={params} name={f.param} value={scoreSel[f.param]} reset={["page", "card"]} options={[{ value: "", label: `Any ${f.label}`, count: scoreCount(f.param, "") }, ...SCORE_BANDS(f.param).map((b) => ({ value: b.key, label: `${f.label[0].toUpperCase()}${f.label.slice(1)} ${b.label}`, count: scoreCount(f.param, b.key) }))]} />
          </div>
        ))}
      </details>
      <div className="toolbar">
        <FilterLinks params={params} name="cap" value={cap} reset={["page", "card"]} options={[{ value: "", label: "Any size", count: capCount("") }, ...SIZE_KEYS.map((s) => ({ value: s.key, label: s.label, count: capCount(s.key) })), { value: "unknown", label: "size unknown", count: capCount("unknown") }]} />
      </div>
      <div className="toolbar">
        <FilterLinks params={params} name="short" value={shortBand} reset={["page", "card"]} options={[{ value: "", label: "Any short interest", count: shortCount("") }, ...SHORT_BANDS.map((b) => ({ value: b.key, label: b.label, count: shortCount(b.key) }))]} />
      </div>
      <div className="toolbar">
        <FilterLinks params={params} name="source" value={source} reset={["page", "card"]} options={[{ value: "", label: "All sources", count: shownCards.length }, ...PLAYERS.filter((p) => sourceCounts.get(p)).map((p) => ({ value: p, label: PLAYER_LABEL[p].replace(/^Scout · /, ""), count: sourceCounts.get(p) }))]} />
      </div>
      {penny.size > 0 && <p className="small muted">{showPenny ? <>Showing {penny.size} short{penny.size === 1 ? "" : "s"} on stocks under $5 (the scout does not suggest these). <a href={hrefWith(params, { penny: undefined })}>Hide them</a></> : <>{penny.size} short{penny.size === 1 ? "" : "s"} on stocks under $5 hidden (the scout does not suggest these). <a href={hrefWith(params, { penny: "1" })}>Show</a></>}</p>}
      <div className="toolbar" style={{ justifyContent: "space-between" }}><CollapseAll /><Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="cards" hash="#cards" /></div>
      {page.items.map((c) => {
        const tr = t.get(c.id) ?? null;
        return (
          <div key={c.id}>
            <div className="small muted from-line">From: {fromLine(playerFor(c), termOf.get(c.id) ?? "", (() => { const o = srcOf(c); return { tag: o.tag, url: o.tag === "Your note" || o.tag === "Your image" ? `#obs-${c.id}` : o.url }; })())}
              {angles.get(c.id)?.length ? <> · also {angles.get(c.id)!.map((id, j) => <span key={id}>{j ? ", " : ""}<a href={hrefWith(params, { card: String(id), page: undefined }, `#card-${id}`)}>card #{id}</a></span>)} <span title="Another angle on the same call from the same source within 14 days: kept on file, scored once">(same call, scored once)</span></> : null}
              {repeats.has(c.id) ? <> · <span className="warn">repeat of <a href={hrefWith(params, { card: String(repeats.get(c.id)), page: undefined }, `#card-${repeats.get(c.id)}`)}>card #{repeats.get(c.id)}</a>: not scored</span></> : null}
            </div>
            <CardView c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate && !tr.invalidatedAt} swingConfigured={sw} excluded={!!tr?.excluded} />} />
          </div>
        );
      })}
      {page.total === 0 && <section className="card"><p className="muted">{cards.length ? "No cards match these filters." : `No cards in the last ${days} days. The scans run at midday on weekdays and hourly for stories.`}</p></section>}
      <Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="cards" hash="#cards" />

    </>
  );
}
