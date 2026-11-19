import { KIND_LABEL, SCOUT, type Kind } from "@/config/scout";
import Direction from "@/components/Direction";
import CardAsk from "@/components/CardAsk";
import CardCollapse from "@/components/CardCollapse";
import CapShort from "@/components/CapShort";
import StockChart from "@/components/StockChart";
import FavoriteStar from "@/components/FavoriteStar";
import Ticker from "@/components/Ticker";
import { chartUrl, tvSymbol } from "@/config/links";
import { cache, Suspense } from "react";
import Feedback from "@/components/Feedback";
import { after } from "next/server";
import { marketDataFromEnv } from "@/lib/alpaca";
import { quote, sessionLabel } from "@/lib/market/quotes";
import { hasDatabase } from "@/lib/db";
import { namesMatch, notCommon } from "@/lib/scout/identity";
import * as store from "@/lib/scout/store";
import type { Feedback as FeedbackRow, StoredCard, StoredReview, Track } from "@/lib/scout/store";
import { addDays, daysBetween, fmtEtAgo, toEt, dayAgo } from "@/lib/time";
import { paperResult } from "@/lib/scout/paper-result";
import { thesisFor } from "@/lib/scout/thesis";

// One read per page render, shared by every card on it.
const recentBriefs = cache(() => store.cardBriefsSince(60).catch(() => [] as store.CardBrief[]));
const favoriteIds = cache(() => store.favorites().then((f) => new Set(f.map((x) => x.cardId))).catch(() => new Set<number>()));
const allTheses = cache(() => import("@/lib/scout/thesis").then(({ cardTheses }) => cardTheses()).catch(() => new Map<number, string>()));

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + ` (${dayAgo(d)})`;

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`);

/** One thesis card, fully laid out. Server component; actions are passed in. */
const VERDICT: Record<string, [string, string]> = { played_out: ["✓ played out", "pos"], did_not: ["✗ did not play out", "neg"], mixed: ["~ mixed", "warn"], too_early: ["… too early to tell", "muted"] };

export default async function CardView({ c, track, actions, feedback, opposing, review }: { c: StoredCard; track?: Track | null; actions?: React.ReactNode; feedback?: FeedbackRow | null; opposing?: number[]; review?: StoredReview | null }) {
  const k = c.card;
  let info = hasDatabase() ? (await store.symbolInfo([c.primaryTicker]).catch(() => new Map())).get(c.primaryTicker) ?? null : null;
  // Not looked up yet (an older card): look it up now, for at most a few seconds; anything slower finishes after the response.
  if (hasDatabase() && !info) {
    const lookup = import("@/lib/scout/symbols").then(({ refreshSymbolInfo }) => refreshSymbolInfo(marketDataFromEnv(), process.env, [c.primaryTicker], new Date())).catch((err) => console.warn(`card #${c.id} symbol lookup: ${err}`));
    const done = await Promise.race([lookup.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
    if (done) info = (await store.symbolInfo([c.primaryTicker]).catch(() => new Map())).get(c.primaryTicker) ?? null;
    else after(() => lookup);
  }
  const q = await quote(c.primaryTicker);
  // A 5%+ move on the card's stock (today, or after hours / pre-market against the last close): a banner with the most likely reason.
  const ext = q?.extPct !== null && q?.extPct !== undefined && Math.abs(q.extPct) >= 5 ? q.extPct : null;
  const bigMove = ext ?? (q?.changePct !== null && q?.changePct !== undefined && Math.abs(q.changePct) >= 5 && sessionLabel(q) === "today" ? q.changePct : null);
  const moveWhen = ext !== null ? q!.extLabel! : "today";
  const moveReason = bigMove !== null ? await (async () => {
    const data = marketDataFromEnv();
    if (!data) return null;
    const news = await data.getNews([c.primaryTicker], new Date(Date.now() - 3 * 3600_000), new Date(), 20).catch(() => []);
    const fast = await import("@/lib/sources/wires").then(({ fastNews }) => fastNews()).catch(() => []);
    return (await import("@/lib/scout/price-watch")).reasonFor({ symbol: c.primaryTicker, phase: moveWhen === "pre-market" ? "pre" : moveWhen === "after hours" ? "post" : "regular" }, [...news, ...fast], new Date()).catch(() => null);
  })() : null;
  // Where the paper entry will be: the same day's open for a card written before 9:30 AM ET, else the next session's.
  const cardDay = toEt(new Date(c.createdAt)).date;
  const pendingEntryDay = (await import("@/lib/scout/tracking")).beforeOpen(cardDay, c.createdAt) ? cardDay : addDays(cardDay, 1);
  const briefs = hasDatabase() ? await recentBriefs() : [];
  const starred = hasDatabase() ? (await favoriteIds()).has(c.id) : false;
  const thesis = thesisFor(c, k.thesis ? undefined : hasDatabase() ? (await allTheses()).get(c.id) : undefined);
  const otherCards = (sym: string) => briefs.filter((b) => b.id !== c.id && (b.primaryTicker === sym || b.tickers.includes(sym)));
  const filing = hasDatabase() ? await import("@/lib/scout/filing-watch").then(({ latestFilingWatch }) => latestFilingWatch([c.primaryTicker])).then((m) => m.get(c.primaryTicker) ?? null).catch(() => null) : null;
  // The paper result so far: the stock against SPY since the entry (open tracks use the live price).
  const spyNow = track?.entryPrice && !track.exitDate ? await quote("SPY").catch(() => null) : null;
  const result = track ? paperResult(track, q?.price ?? null, spyNow?.price ?? null) : null;
  const company = k.tickers.find((t) => t.symbol === c.primaryTicker)?.company ?? null;
  // Warn when the symbol trades as something other than the company's stock (a reused ticker).
  const wrong = !!info?.name && (info.tradable === false || !!notCommon(info.name) || (!!company && !namesMatch(company, info.name)));
  const today = toEt(new Date()).date;
  const nextE = info?.nextEarnings && daysBetween(today, info.nextEarnings) >= -3 ? info.nextEarnings : null;
  const beforeExit = nextE && track && !track.exitDate && nextE <= track.deadlineDate;
  return (
    <CardCollapse id={c.id}>
      <div>
        <div className="inline">
          {hasDatabase() && <FavoriteStar cardId={c.id} initial={starred} />}
          <a className="tag card-number" href={`/ideas?days=365&card=${c.id}#card-${c.id}`} title="Link to this card">#{c.id}</a>
          <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span>
          <span className="tag">{KIND_LABEL[c.kind as Kind] ?? c.kind}</span>
          <span className="tag">{c.origin === "human" ? "human-originated" : "scout"}</span>
          <span className="small muted" title={`card #${c.id} · ${c.model} · version ${c.versionId}`}>{fmtEtAgo(c.createdAt)}</span>
        </div>
        {track?.invalidatedAt && (
          <div className="invalidated-banner">
            <div className="invalidated-label">✗ INVALIDATED</div>
            <div className="invalidated-note">{(track.invalidatedNote ?? "").replace(/^automatic: /, "") || "Marked by you."}</div>
            <div className="small">{track.invalidatedNote?.startsWith("automatic: ") ? "Found by the scout's invalidation watch" : "Marked by you"} · {fmtEtAgo(track.invalidatedAt)} · {track.exitDate ? `paper trade exited ${track.exitDate}` : "paper trade exits at the next open"}</div>
          </div>
        )}
        {filing && filing.status !== "ok" && (
          <div className={`filing-banner ${filing.status === "late_vs_usual" ? "" : "severe"}`}>
            <div className="filing-label">⚠ {filing.status === "red_flag" ? "SEC RED FLAG" : filing.status === "past_due" ? "REPORT PAST DUE" : filing.status === "nt_filed" ? "LATE-FILING NOTICE" : "REPORT LATER THAN USUAL"}</div>
            <div>{filing.message}</div>
            <div className="small">Filing watch · checked {fmtEtAgo(filing.checkedAt)}{filing.cik ? <> · <a href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${filing.cik}&type=&dateb=&owner=include&count=40`} target="_blank" rel="noreferrer">SEC filings</a></> : null}</div>
          </div>
        )}
        {bigMove !== null && (
          <div className={`move-banner ${(bigMove < 0) === (c.direction === "long") ? "against" : "with"}`}>
            <b>{bigMove < 0 ? "📉" : "📈"} {c.primaryTicker} {bigMove > 0 ? "+" : "−"}{Math.abs(bigMove).toFixed(1)}% {moveWhen}</b>
            <span className="small"> · {(bigMove < 0) === (c.direction === "long") ? `against this ${c.direction}` : `in this ${c.direction}'s favour`}</span>
            <div className="small">{moveReason ? <>Likely reason: {moveReason.url.startsWith("http") ? <a href={moveReason.url} target="_blank" rel="noreferrer">{moveReason.headline}</a> : moveReason.headline} <span className="muted">({moveReason.source})</span></> : "No headline in the scout's feeds yet: the news may be on X, in a short report or a niche outlet."}</div>
          </div>
        )}
        {track?.excluded && <div className="small neg" style={{ marginTop: 6 }}><b>Excluded from scoring: wrong security.</b> {track.excluded}</div>}
        <div style={{ margin: "8px 0 4px" }}><Direction direction={c.direction} ticker={c.primaryTicker} name={info?.name ?? company ?? (info ? "company name unavailable" : "company name loading — reload in a moment")} warn={wrong} />
          {q ? (
            <span className="quote" title={`Last trade ${q.at ? fmtEtAgo(q.at) : ""} (IEX feed; may differ slightly from the consolidated price). Change vs the previous session's close.`}>
              <b>${q.price.toFixed(q.price < 1 ? 4 : 2)}</b>
              {q.changePct !== null && <span className={q.changePct >= 0 ? "pos" : "neg"}> {pct(q.changePct, 2)} {sessionLabel(q)}</span>}
              {q.extPct !== null && q.extPct !== undefined && <span className={q.extPct >= 0 ? "pos" : "neg"} title={`Last trade ${q.extLabel} (thin trading on IEX), against the last regular close`}> · {pct(q.extPct, 2)} {q.extLabel}</span>}
            </span>
          ) : null}
          {hasDatabase() && <Suspense fallback={null}><CapShort symbol={c.primaryTicker} price={q?.price ?? null} /></Suspense>}
          {c.direction === "short" && q && (q.price < SCOUT.minShortPrice || (q.changePct ?? 0) >= 15) ? (
            <span className="tag not_promoted" style={{ marginLeft: 8 }} title="Cheap or fast-rising stocks are often hard and costly to borrow and can squeeze far past a stop; losses on a short are open-ended.">
              ⚠ dangerous to short: {q.price < SCOUT.minShortPrice ? `under $${SCOUT.minShortPrice}` : `up ${q.changePct}% ${sessionLabel(q)}`}; defined-risk puts or no trade
            </span>
          ) : null}
          {opposing?.length ?<span className="tag warn" style={{ marginLeft: 8 }}>⚠ opposite call on {c.primaryTicker}: {opposing.map((id) => <a key={id} href={`/ideas?days=90&card=${id}#card-${id}`}>#{id} </a>)}</span> : null}</div>
        <div className="small secondary">
          {nextE ? <>Next earnings <b>~{fmtDay(nextE)}</b> <span className="muted">({info!.nextBasis})</span></>
            : info?.lastEarnings ? <>Next earnings: not enough history to estimate <span className="muted">(last release {fmtDay(info.lastEarnings)})</span></>
            : info ? <>Next earnings: unknown <span className="muted">(no earnings releases on file at the SEC — a fund, an ADR or a new listing)</span></>
            : <>Next earnings: loading — reload in a moment</>}
          {beforeExit ? <span className="tag warn" style={{ marginLeft: 6 }}>before this card&apos;s exit ({fmtDay(track!.deadlineDate)})</span> : null}
        </div>
        <h2 style={{ margin: "6px 0 2px" }}>{k.title}</h2>
        <div className={`card-thesis card-thesis-${c.direction}`}><span className="card-thesis-label">{c.direction === "long" ? "▲" : "▼"} Thesis</span> {thesis}</div>
        <div className="scores">
          <span>novelty <b>{k.scores.novelty}</b></span><span>materiality <b>{k.scores.materiality}</b></span><span>breadth <b>{k.scores.breadth_of_evidence}</b></span>
          <span>lateness <b>{k.scores.lateness}</b></span><span>confidence <b>{k.confidence}</b></span><span>rank <b>{c.rankScore}</b></span>
        </div>
      </div>
      <dl>
        <dt>Observation</dt><dd>{k.observation}</dd>
        <dt>Why not priced</dt><dd>{k.why_not_priced}</dd>
        <dt>Tickers</dt>
        <dd>{k.tickers.map((t, i) => <div key={t.symbol}><b><Ticker symbol={t.symbol} className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲" : "▼"} {t.symbol}</Ticker></b> {i === 0 ? <span className="tag">tracked on paper</span> : null}
          {otherCards(t.symbol.toUpperCase()).slice(0, 6).map((b) => <a key={b.id} className="tag card-number" style={{ marginLeft: 4 }} href={`/ideas?days=90&card=${b.id}#card-${b.id}`} title={`Card #${b.id}, ${b.direction} ${b.primaryTicker}, ${b.status.replace("_", " ")}, ${fmtEtAgo(b.createdAt)}`}><span className={b.direction === "long" ? "pos" : "neg"}>{b.direction === "long" ? "▲" : "▼"}</span> #{b.id} <span className="muted">{fmtDay(toEt(new Date(b.createdAt)).date).replace(/, \d{4}$/, "")}</span></a>)} <span className="small muted">({t.sector.replace("_", " ")}{t.revenue_share_pct === null ? ", share unknown" : `, ${t.revenue_share_pct}% of revenue${t.share_is_estimate ? " (estimate)" : ""}`})</span> — {t.why}</div>)}</dd>
        <dt>Lateness</dt>
        <dd className={k.lateness.already_obvious ? "warn" : ""}>{pct(k.lateness.stock_move_30d_pct)} over 30 days, {pct(k.lateness.stock_move_90d_pct)} over 90 days, {k.lateness.news_stories_30d} mainstream stories in 30 days{k.lateness.already_obvious ? " — already obvious" : ""}</dd>
        <dt>Catalyst</dt><dd>{k.catalyst.what} <span className="muted">({k.catalyst.date})</span></dd>
        <dt>Invalidation</dt><dd>{k.invalidation}</dd>
        <dt>Time limit</dt><dd>{k.time_limit_days} days</dd>
        {k.expression && <><dt>How to trade it</dt><dd>{k.expression} <span className="small muted">(timing note, not a recommendation; tracked in shares)</span></dd></>}
        {k.unknowns.length > 0 && <><dt>Unknowns</dt><dd>{k.unknowns.join("; ")}</dd></>}
        {c.gateNotes.length > 0 && <><dt>Gate notes</dt><dd className="small secondary">{c.gateNotes.join(" · ")}</dd></>}
        {track && <><dt>Paper track</dt><dd className="small">
          {result && <div className={`paper-result ${result.ret >= 0 ? "pos" : "neg"}`}><b>{result.closed ? "Result" : "So far"}: {pct(result.ret * 100)}</b>{result.spy !== null && <span className="muted"> · SPY {pct(result.spy * 100)} · </span>}{result.spy !== null && <b className={result.ret - result.spy >= 0 ? "pos" : "neg"}>{pct((result.ret - result.spy) * 100)} vs SPY</b>}<span className="muted"> · {c.direction === "short" ? "short" : "long"}, {result.days} day{result.days === 1 ? "" : "s"}{result.closed ? "" : " (live price)"}</span></div>}
          {trackLine(track)}</dd></>}
        {review && <><dt>After the catalyst</dt><dd className="small"><b className={VERDICT[review.verdict]?.[1] ?? ""}>{VERDICT[review.verdict]?.[0] ?? review.verdict}</b> <span className="muted">({fmtEtAgo(review.createdAt)}{review.moveSinceEntryPct !== null ? `; trade ${review.moveSinceEntryPct >= 0 ? "+" : ""}${review.moveSinceEntryPct}% since entry` : ""})</span> — {review.summary}{review.evidence.length ? <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{review.evidence.map((e, i) => <li key={i} className="muted">{e.date} [{e.source}] {e.headline}</li>)}</ul> : null}</dd></>}
      </dl>
      <div>
        <h3>Evidence</h3>
        <ul className="evidence">{k.evidence.map((e, i) => <li key={i}><span className="src">{e.source}</span>{e.metric}: {e.value} <span className="muted">({e.change_vs_12m} vs 12m, as of {e.as_of})</span></li>)}</ul>
      </div>
      <div className="card-chart">
        <div className="small muted card-chart-head"><span>{c.primaryTicker} · chart</span><a href={chartUrl(c.primaryTicker)} target="_blank" rel="noreferrer">Open full chart →</a></div>
        <StockChart symbol={c.primaryTicker} tvSymbol={tvSymbol(c.primaryTicker, info?.exchange)} entry={track?.entryDate && track.entryPrice ? { date: track.entryDate, price: track.entryPrice, direction: track.direction, exitDate: track.exitDate, exitPrice: track.exitPrice, label: "scout entry", cardId: c.id } : { date: pendingEntryDay, price: null, direction: c.direction, label: "entry at the next open", cardId: c.id }} />
      </div>
      <div className="actions">{actions}<CardAsk cardId={c.id} symbol={c.primaryTicker} tickers={k.tickers.map((t) => t.symbol)} /></div>
      <Feedback target={`card:${c.id}`} initial={feedback ? { vote: feedback.vote, note: feedback.note } : null} />
    </CardCollapse>
  );
}

function trackLine(t: Track): string {
  if (!t.entryDate) return `entry pending: next open after ${t.cardDate}; exit by ${t.deadlineDate}`;
  const entry = `entered ${t.entryDate} at ${t.entryPrice?.toFixed(2)}`;
  if (t.exitDate) return `${entry}; exited ${t.exitDate} at ${t.exitPrice?.toFixed(2)} (${t.exitReason}); worst drawdown ${pct(t.maxDrawdownPct)}`;
  return `${entry}; open, exit by ${t.deadlineDate}; worst drawdown so far ${pct(t.maxDrawdownPct)}${t.tappedAt ? "; sent to the Swing ideas log" : ""}`;
}
