import CardActions from "@/components/CardActions";
import { originLink } from "@/lib/scout/origin-tag";
import CardView from "@/components/CardView";
import { CollapseAll } from "@/components/CardCollapse";
import Pager, { hrefWith, paginate } from "@/components/Pager";
import IdeasFilters, { type FilterGroup } from "@/components/IdeasFilters";
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
/** What to sort by, and the two orders each can be shown in (the first is the default). */
const SORTS = [
  { value: "best", label: "Best", fwd: "Best first", rev: "Worst first" },
  { value: "newest", label: "Date", fwd: "Newest first", rev: "Oldest first" },
  { value: "confidence", label: "Confidence", fwd: "Highest first", rev: "Lowest first" },
  { value: "catalyst", label: "Catalyst date", fwd: "Soonest first", rev: "Latest first" },
  { value: "short", label: "Short interest", fwd: "Highest first", rev: "Lowest first" },
];
/** Earlier links: the reversed orders used to be sorts of their own. */
const OLD_SORTS: Record<string, string> = { oldest: "newest", confidence_low: "confidence" };
/** The periods on offer; ALL_DAYS reaches back before the first card. */
const ALL_DAYS = 3650;
const PERIODS = [7, 30, 90, 365, ALL_DAYS];
const periodLabel = (d: number) => (d === ALL_DAYS ? "All dates" : d === 365 ? "1 year" : `${d} days`);
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

type SP = { days?: string; source?: string; status?: string; sort?: string; rev?: string; conf?: string; cap?: string; short?: string; dir?: string; penny?: string; page?: string; card?: string } & Partial<Record<ScoreParam, string>>;

export default async function IdeasPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 7;
  const sort = SORTS.some((s) => s.value === sp.sort) ? sp.sort! : OLD_SORTS[sp.sort ?? ""] ?? "best";
  const rev = sp.rev === "1" || !!OLD_SORTS[sp.sort ?? ""];
  // Each filter group takes any number of values (comma-separated in the address); none = any.
  const many = (v: string | undefined, ok: (x: string) => boolean) => new Set((v ?? "").split(",").map((x) => x.trim()).filter((x) => x && ok(x)));
  const sel: Record<string, Set<string>> = {
    dir: many(sp.dir, (x) => x === "long" || x === "short"),
    status: many(sp.status, (x) => x in STATUS_RANK),
    conf: many(sp.conf, (x) => CONF_BANDS.some((b) => b.key === x)),
    cap: many(sp.cap, (x) => SIZE_KEYS.some((s) => s.key === x) || x === "unknown"),
    short: many(sp.short, (x) => SHORT_BANDS.some((b) => b.key === x)),
    ...Object.fromEntries(SCORE_FILTERS.map((f) => [f.param, many(sp[f.param], (x) => SCORE_BANDS(f.param).some((b) => b.key === x))])),
    source: many(sp.source, (x) => (PLAYERS as readonly string[]).includes(x)),
  };
  const joined = (k: string) => (sel[k].size ? [...sel[k]].join(",") : undefined);
  const params: Record<string, string | undefined> = { days: days === 7 ? undefined : String(days), sort: sort === "best" ? undefined : sort, rev: rev ? "1" : undefined, ...Object.fromEntries(Object.keys(sel).map((k) => [k, joined(k)])), penny: sp.penny, page: sp.page };

  const [cards, candidates, tracks, fb, recent] = await Promise.all([store.cardsSince(days), store.candidatesSince(days), store.allTracks(), store.latestFeedback(), store.cardsSince(120)]);
  const [reviews, profiles] = await Promise.all([store.allReviews(), profilesForCards(cards)]);
  // No shorts under $5: such cards stay in the log but are hidden unless asked for (older cards checked at today's price).
  const showPenny = sp.penny === "1";
  const shortSyms = [...new Set(cards.filter((c) => c.direction === "short").map((c) => c.primaryTicker))];
  const shortPx = shortSyms.length ? await (marketDataFromEnv()?.getSnapshots?.(shortSyms) ?? Promise.resolve({} as Record<string, { price: number }>)).catch(() => ({} as Record<string, { price: number }>)) : {};
  const penny = new Set(cards.filter((c) => isPennyShort(c, shortPx[c.primaryTicker]?.price)).map((c) => c.id));
  // Size and short-interest filters: the card's market cap and % of float short (frozen when written, else today's).
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

  // The filter groups: what each card's value is in that group, and the choices offered.
  const band = (bands: ReadonlyArray<{ key: string; lo: number; hi: number }>, v: number | null) => (v === null ? "unknown" : bands.find((b) => v >= b.lo && v < b.hi)?.key ?? "");
  const GROUPS: Array<{ param: string; title: string; options: Array<{ value: string; label: string }>; keyOf: (c: store.StoredCard) => string; scores?: boolean }> = [
    { param: "dir", title: "Side", options: [{ value: "long", label: "▲ Long" }, { value: "short", label: "▼ Short" }], keyOf: (c) => c.direction },
    { param: "status", title: "Status", options: [{ value: "promoted", label: "Promoted" }, { value: "late", label: "Late" }, { value: "not_promoted", label: "Not promoted" }], keyOf: (c) => c.status },
    { param: "conf", title: "Confidence", options: CONF_BANDS.map((b) => ({ value: b.key, label: b.label.replace(/^Confidence /, "") })), keyOf: (c) => band(CONF_BANDS, c.card.confidence) },
    { param: "cap", title: "Size", options: [...SIZE_KEYS.map((s) => ({ value: s.key, label: s.label })), { value: "unknown", label: "unknown" }], keyOf: (c) => sizeKey(profiles.get(c.id)?.marketCap) ?? "unknown" },
    { param: "short", title: "Short interest", options: SHORT_BANDS.map((b) => ({ value: b.key, label: b.label.replace(/^Short /, "") })), keyOf: (c) => band(SHORT_BANDS.filter((b) => b.key !== "unknown"), shortPct(profiles.get(c.id))) },
    ...SCORE_FILTERS.map((f) => ({ param: f.param, title: `${f.label[0].toUpperCase()}${f.label.slice(1)}`, options: SCORE_BANDS(f.param).map((b) => ({ value: b.key, label: b.label })), keyOf: (c: store.StoredCard) => band(SCORE_BANDS(f.param), f.get(c)), scores: true })),
    { param: "source", title: "Source", options: PLAYERS.filter((pl) => cards.some((c) => playerFor(c) === pl)).map((pl) => ({ value: pl, label: PLAYER_LABEL[pl].replace(/^Scout · /, "") })), keyOf: (c) => playerFor(c) },
  ];
  /** Does a card pass every group (but one, for that group's own counts)? */
  const passes = (c: store.StoredCard, except?: string) => GROUPS.every((g) => g.param === except || !sel[g.param].size || sel[g.param].has(g.keyOf(c)));

  // One list of every card in the window: filtered by source and status, sorted, 10 a page.
  const wantedId = Number(sp.card);
  const base = cards.filter((c) => (!repeats.has(c.id) || c.id === wantedId) && (showPenny || !penny.has(c.id) || c.id === wantedId));
  // A catalyst still to come, else none (those go last in either order).
  const due = (c: { catalystDate: string | null }) => (c.catalystDate && c.catalystDate >= today ? c.catalystDate : null);
  const flip = rev ? -1 : 1;
  // % of float short (the same number the Short interest filter uses); cards without one go last in either order.
  const si = (c: { id: number }) => shortPct(profiles.get(c.id)) ?? null;
  const rows = base.filter((c) => passes(c) || c.id === wantedId).sort((a, b) =>
    sort === "newest" ? flip * b.createdAt.localeCompare(a.createdAt)
      : sort === "confidence" ? flip * (b.card.confidence - a.card.confidence || b.rankScore - a.rankScore)
      : sort === "short" ? (si(a) !== null && si(b) !== null ? flip * (si(b)! - si(a)!) : Number(si(a) === null) - Number(si(b) === null)) || b.rankScore - a.rankScore
      : sort === "catalyst" ? (due(a) && due(b) ? flip * due(a)!.localeCompare(due(b)!) : Number(!due(a)) - Number(!due(b))) || b.rankScore - a.rankScore
        : flip * (STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.rankScore - a.rankScore || b.createdAt.localeCompare(a.createdAt)));
  const wanted = Number(sp.card);
  const at = wanted ? rows.findIndex((c) => c.id === wanted) : -1;
  const page = paginate(rows, at >= 0 ? Math.floor(at / PAGE) + 1 : Number(sp.page ?? 1), PAGE);

  // Each choice's count: the cards it would add, given the other groups as they are now.
  const filterGroups: FilterGroup[] = GROUPS.map((g) => ({
    param: g.param, title: g.title, scores: g.scores, selected: [...sel[g.param]],
    options: g.options.map((o) => ({ ...o, count: base.filter((c) => passes(c, g.param) && g.keyOf(c) === o.value).length })),
  }));
  // What is filtered, in words, for the folded filters line.
  const summary = [periodLabel(days), (() => { const x = SORTS.find((o) => o.value === sort)!; return `${x.label}: ${(rev ? x.rev : x.fwd).toLowerCase()}`; })(),
    ...GROUPS.filter((g) => sel[g.param].size).map((g) => `${g.title.toLowerCase()}: ${g.options.filter((o) => sel[g.param].has(o.value)).map((o) => o.label).join(" or ")}`),
    `${rows.length} card${rows.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");

  return (
    <>
      <h1>Ideas</h1>
      <RememberFilters keys={["days", "sort", "rev", "status", "source", "conf", "cap", "short", "dir", ...SCORE_FILTERS.map((f) => f.param)]} />
      <TickerSearch />
      <details className="card notice small section">
        <summary><b>How this page works</b></summary>
        Every thesis card from every desk in one list: the trend desk (watch-list and discovery), the story desk (breaking news), filings, insiders and Congress, unusual options positions, Trump&apos;s posts, your bot&apos;s inbox, and what you noticed yourself.
        &quot;Best first&quot; puts promoted cards first, then late, then not promoted, each by novelty × materiality. Every promoted and late card is tracked on paper from the next open after the card to the earlier of the day after its catalyst, its time limit or the invalidation being met, whether or not you send it to the Swing ideas log.
        Late cards (already up a lot or already everywhere in the news) are logged and tracked so the lateness gate can be checked. Market panels, upcoming catalysts and the desks' reports (including everything considered and rejected) are on Home.
        {!sw && <div className="muted" style={{ marginTop: 6 }}>Sending to the Swing ideas log is not configured yet (SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD).</div>}
      </details>
      <span id="cards" />
      {/* All the filters fold away (remembered); tick any number per group, then Apply. */}
      <IdeasFilters days={String(days)} sort={sort} rev={rev} sorts={SORTS} groups={filterGroups} summary={summary} keep={{ penny: sp.penny ?? "" }} />
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
      {page.total === 0 && <section className="card"><p className="muted">{cards.length ? "No cards match these filters." : `No cards ${days === ALL_DAYS ? "yet" : `in the last ${days} days`}. The scans run at midday on weekdays and hourly for stories.`}</p></section>}
      <Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="cards" hash="#cards" />

    </>
  );
}
