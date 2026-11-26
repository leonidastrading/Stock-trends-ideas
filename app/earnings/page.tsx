import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { allCards, allDocs, allTracks, EARN, EARN_VERSION, historyCount, isA, isShortStudy, isStudy, measuredLate, peerBench, scansSince, score, snapshotCount, weekOf, type CardRow, type DocRow, type Group, type ScanRow, type TrackRow } from "@/lib/scout/earnings";
import { calendarDay } from "@/lib/sources/earnings-data";
import { addDays, etLabelAgo, toEt, dayAgo } from "@/lib/time";
import EarningsSend from "./EarningsSend";
import TabNew from "@/components/TabNew";
import NewSince from "@/components/NewSince";
import StockChart from "@/components/StockChart";
import ResearchButton from "@/components/ResearchButton";
import EarningsResearch from "./EarningsResearch";
import { tvSymbol } from "@/config/links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIER: Record<string, number> = { "A++": 0, "A+": 1, A: 2 };
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "?" : `${x > 0 ? "+" : ""}${x.toFixed(d)}%`);
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) + ` (${dayAgo(d)})`;

/** Earnings drift (up): the nightly earnings scan, its setups, open paper positions, rejected candidates and the scoreboard. */
export default async function EarningsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const data = marketDataFromEnv();
  const today = toEt(new Date()).date;
  const [loaded, tracks, cards, docs, history, snaps, backfill] = await Promise.all([
    scansSince(800, today), allTracks(), allCards(), allDocs(), historyCount().catch(() => 0), snapshotCount().catch(() => 0),
    import("@/lib/scout/store").then((s) => s.cacheGet<{ next: string; floor: string }>("earnings:backfill")).catch(() => null),
  ]);
  // Rows an older scan measured a day late are measured again on the report day, here and now (a few seconds, once).
  let scans = loaded;
  if (data && scans.some(measuredLate)) {
    const fixed = await Promise.race([import("@/lib/scout/earnings").then(({ repairLateScans }) => repairLateScans(data)).then((r) => { console.log(`earnings repair: ${r}`); return true; }).catch((e) => { console.warn(`earnings repair failed: ${e instanceof Error ? e.message : e}`); return false; }), new Promise<boolean>((r) => setTimeout(() => r(false), 12_000))]);
    if (fixed) scans = await scansSince(800, today).catch(() => scans);
  }
  const trackBy = new Map(tracks.map((t) => [t.scanId, t]));
  const cardBy = new Map(cards.map((c) => [c.scanId, c]));
  const docBy = new Map(docs.map((d) => [d.scanId, d]));
  const scanBy = new Map(scans.map((s) => [s.id, s]));
  const recent = scans.filter((s) => s.reactionDate >= addDays(today, -14));
  const aRecent = recent.filter((s) => isA(s.setup)).sort((x, y) => {
    const cx = cardBy.get(x.id)?.card, cy = cardBy.get(y.id)?.card;
    const px = cx?.ai_recommendation === "promote" ? 0 : cx ? 1 : 2, py = cy?.ai_recommendation === "promote" ? 0 : cy ? 1 : 2;
    return px - py || TIER[x.setup!] - TIER[y.setup!] || y.reactionDate.localeCompare(x.reactionDate);
  });
  const study = scans.filter((s) => isStudy(s.setup) && s.reactionDate >= addDays(today, -30));
  const rejected = recent.filter((s) => !s.setup && s.reason && !/^surprise rank|^no consensus snapshot/.test(s.reason));
  // Open positions: the setups (every report is tracked for the benchmark, but only setups are shown here).
  const open = tracks.filter((t) => !t.closed && scanBy.get(t.scanId)?.setup);
  const snapsNow = data?.getSnapshots && open.length ? await data.getSnapshots([...new Set(open.map((t) => scanBy.get(t.scanId)!.symbol))]).catch(() => ({})) : {};
  const week = data ? await (async () => {
    const sessions = (await data.getCalendar(today, addDays(today, 10)).catch(() => [])).map((s) => s.date).slice(0, 5);
    return Promise.all(sessions.map(async (d) => ({ d, n: (await calendarDay(d).catch(() => [])).filter((r) => r.marketCap !== null && r.marketCap >= EARN.minCap && r.marketCap < EARN.maxCap).length })));
  })().catch(() => []) : [];

  return (
    <>
      <h1>Drift</h1>
      <div className="toolbar"><span className="filter-links small"><a className="chip" href="/drift">Down drift (bad news)<TabNew tab="drift" /></a><a className="chip active" href="/earnings">Earnings drift (up)</a><a className="chip" href="/upgrades">Upgrades (up)</a></span></div>
      <details className="card section">
        <summary><b>How this works</b> <span className="small muted">big earnings beats that keep drifting up for ~60 trading days</span></summary>
        <div className="small secondary">
          <p>Every night after the close the scout checks every US earnings report whose reaction day just ended (before-open reports: that day; after-close: the next day). Universe: US stocks, price ${EARN.minPrice}+, market cap $1B-$200B as of the report, enough trading; consumer staples, utilities, communication services and real estate are left out of setups.</p>
          <ul>
            <li><b>No look-ahead.</b> Consensus EPS and revenue, market cap and year-ago EPS are frozen before each report (the latest capture before the release, with its time). The surprise uses only that snapshot; a report without one stays in the benchmark but cannot be a setup. Surprise and run-up ranks use only the 12 months before the report.</li>
            <li><b>A</b>: the top 20% by (actual EPS − consensus) ÷ the close before the news, against the last 12 months of reports in the same size group (under $2B, $2-10B, $10-200B), on reaction-day volume of {EARN.minVolumeRatio}× normal or more. <b>A+</b>: reported within {EARN.earlyDays} days of quarter end. <b>A++</b>: also in the top third of 10-day run-ups, ranked the same way.</li>
            <li>Study only, never promoted: <b>A0</b> a big beat on quiet volume (to compare populations); <b>B</b> a $1-10B company that missed and gapped up more than {EARN.gapPct}%; <b>C</b> a $10B+ company below the year-ago quarter&apos;s actual EPS (same street basis; from the scout&apos;s own history, else Nasdaq&apos;s year-ago figure) that gapped down more than {EARN.gapPct}% (paper shorts); <b>D</b> a big beat (top 20% surprise) the market sold more than {EARN.gapPct}% against SPY on the reaction day: the reaction points down, so it is kept out of A and tracked as a paper short to see whether these keep falling.</li>
            <li><b>Every report in the universe is tracked</b> the same way: entry at the next open, exit at the close of the session before the next report (rechecked daily; a confirmed date moves it, earlier or later, and each move is logged), or 60 sessions. The benchmark for a setup is the average excess over SPY of the other reports in its size group and report week. Returns are also measured from the reaction-day close.</li>
            <li>For each A-setup the AI reads the SEC press release filed by the reaction day and the headlines published before the paper entry, and judges the beat (high: revenue beat, guidance up, margins up; low: tax, buybacks, one-offs, guidance cut). The numbers come from the feeds; the AI cannot change them. The scout also reads the guidance direction from the press release&apos;s wording, without the model, for the numeric baseline.</li>
          </ul>
          <p>Research basis: 2015-2026, ~63,000 reports; the big-beat drift was about +1.2% over 60 days vs the average report (+1.7% with the filters), lumpy (5 of 12 years flat or negative), about half the trades win.</p>
          <p>Data: Nasdaq earnings calendar (consensus and actual street EPS, timing, market cap, quarter end, year-ago EPS) and sector; Alpaca prices (IEX volume, so the liquidity floor is ${(EARN.minIexDollarVolume / 1e6).toFixed(1)}M a day on IEX, about $10M overall); revenue from Finnhub (asked again by symbol, then Financial Modeling Prep, when the calendar has none; hover a row's revenue for its source); press releases from the SEC (the 8-K, or a foreign company's 6-K). The earnings desk has its own AI budget in Settings.</p>
          <p className="muted">Version {EARN_VERSION}. Consensus snapshots: {snaps.toLocaleString("en-US")}. Surprise history: {history.toLocaleString("en-US")} reports{backfill?.data ? (backfill.data.next < backfill.data.floor ? " (full year loaded)" : `, loading back to ${backfill.data.floor} (now at ${backfill.data.next})`) : ", loading starts with the hourly job"}; past estimates are the calendar&apos;s as published now (no snapshot exists for the past), forward ones come from snapshots.</p>
        </div>
      </details>

      {week.length > 0 && (
        <div className="card section small">
          <b>This week:</b> {week.map((w) => <span key={w.d} style={{ marginRight: 14 }}>{dayLabel(w.d)} <b>{w.n}</b></span>)}
          <span className="muted"> reports from $1-200B companies; about 1 in 5 beats big enough for an A-setup, fewer after the sector, volume and timeliness filters.</span>
        </div>
      )}

      <h2>Setups (last 14 days)</h2>
      {aRecent.length === 0 && <p className="small muted">No A-setups in the last 14 days.</p>}
      {aRecent.map((s) => <SetupCard key={s.id} s={s} t={trackBy.get(s.id) ?? null} c={cardBy.get(s.id) ?? null} d={docBy.get(s.id) ?? null} />)}

      <h2>Open paper positions ({open.length})</h2>
      {open.length === 0 ? <p className="small muted">None yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Stock</th><th>Setup</th><th>Entry</th><th className="num">Held</th><th className="num">Return</th><th>Exit</th></tr></thead>
          <tbody>{open.map((t) => {
            const s = scanBy.get(t.scanId)!;
            const snap = (snapsNow as Record<string, { price?: number }>)[s.symbol];
            const ret = t.entryPrice && snap?.price ? (snap.price / t.entryPrice - 1) * 100 : null;
            const held = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${t.entryDate}T12:00:00Z`)) / 86400_000));
            const toExit = t.exitDate ? Math.round((Date.parse(`${t.exitDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000) : null;
            const short = isShortStudy(s.setup);
            return (
              <tr key={t.scanId}>
                <td><Ticker symbol={s.symbol} className={short ? "neg" : "pos"} />{t.tappedAt ? <span className="tag ok">sent</span> : null}<NewSince tab="earnings" at={s.createdAt} /></td>
                <td className="small">{s.setup}{s.setup === "A0" || short ? ` (study${short ? ", short" : ""})` : ""}</td>
                <td className="small">{t.entryDate}{t.entryPrice ? ` @ $${t.entryPrice.toFixed(2)}` : " (next open)"}</td>
                <td className="num small">{held}d</td>
                <td className={`num small ${ret !== null && (short ? -ret : ret) >= 0 ? "pos" : "neg"}`}>{pct(ret)}</td>
                <td className="small">{t.exitDate ?? "?"}{toExit !== null ? <span className="muted"> ({toExit}d; {t.nextKnown ? `report confirmed ${t.nextReport}` : "report date estimated"}{t.exitMoves.length ? `; moved ${t.exitMoves.length}×` : ""})</span> : null} {t.worstPct !== null ? <span className="muted">· worst {pct(t.worstPct)}</span> : null}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}

      {study.length > 0 && (
        <details className="card section">
          <summary><b>Study setups A0, B, C and D (last 30 days, {study.length})</b> <span className="small muted">tracked to compare, never promoted</span></summary>
          <ul className="small">{study.map((s) => <li key={s.id}><Ticker symbol={s.symbol} className={s.setup === "A0" ? "accent" : "neg"} /> <b>{s.setup}</b> · reported {s.reportDate} · EPS {s.numbers.eps_actual} vs {s.numbers.eps_consensus} · reaction {pct(s.numbers.reaction_pct)} on {s.numbers.volume_ratio ?? "?"}× volume · ${s.numbers.market_cap_b}B {s.numbers.sector ?? ""}{s.setup === "C" ? ` · year-ago EPS ${s.numbers.year_ago_eps} (${s.numbers.year_ago_source})` : ""}</li>)}</ul>
        </details>
      )}

      <details className="card section">
        <summary><b>Candidates rejected (last 14 days, {rejected.length})</b> <span className="small muted">reports that came close, and why they did not count</span></summary>
        {rejected.length === 0 ? <p className="small muted">None.</p> : <ul className="small">{rejected.map((s) => <li key={s.id}><Ticker symbol={s.symbol} /> reported {s.reportDate} · EPS {s.numbers.eps_actual} vs {s.numbers.eps_consensus} (rank {s.numbers.surprise_pct_rank ?? "?"}) · reaction {pct(s.numbers.reaction_pct)} · <span className="warn">{s.reason}</span></li>)}</ul>}
      </details>

      <Scoreboard scans={scans} tracks={tracks} cards={cards} docs={docs} />
    </>
  );
}

function SetupCard({ s, t, c, d }: { s: ScanRow; t: TrackRow | null; c: CardRow | null; d: DocRow | null }) {
  const n = s.numbers, k = c?.card;
  return (
    <section className="card earnings-card">
      <div>
        <Ticker symbol={s.symbol} className="pos" /> <span className="tag late">{s.setup}</span>{" "}
        {k ? <span className={`tag ${k.ai_recommendation === "promote" ? "ok" : ""}`}>{k.ai_recommendation === "promote" ? "promoted" : "log only"}</span> : <span className="tag">card waiting</span>}{" "}
        {measuredLate(s) && <span className="tag warn" title="This before-open report was measured on the session after it (a fault in the scan, fixed Nov 26, 2026). The reaction, volume and run-up shown are the second day's, the run-up includes the earnings jump, and the paper entry is a session later than the rule. The desk writes no card on it.">⚠ measured a day late: numbers are the second day&apos;s</span>}{" "}
        {s.fixed && <span className="tag warn" title={`${s.fixed.why}. The first measurement said: reaction ${pct(s.fixed.was.reaction_pct)} vs SPY on ${s.fixed.was.volume_ratio ?? "?"}x volume, run-up ${s.fixed.was.runup_10d_pct === null ? "?" : pct(s.fixed.was.runup_10d_pct)} (rank ${s.fixed.was.runup_pct_rank ?? "?"}), setup ${s.fixed.was.setup ?? "none"}. Those were the second day's numbers, and the run-up included the earnings jump. The first measurement stays on file; the paper entry was a session late and is not moved.`}>corrected: measured again on the report day{s.fixed.was.setup !== s.setup ? ` (was ${s.fixed.was.setup ?? "no setup"})` : ""}</span>}{" "}
        {n.scanned_late && <span className="tag" title="The results were not published in time for the scan on the report's own night, so it was found a night later. The reaction is the report day's; the paper entry is one session later than the rule.">found a night late</span>}{" "}
        {isA(s.setup) && n.reaction_pct <= -EARN.gapPct && <span className="tag warn" title={`The market sold this beat: ${pct(n.reaction_pct)} vs SPY on the reaction day. The rule ranks the EPS beat and volume only, so it is still tracked as an up-drift setup on paper; the reaction itself points down.`}>⚠ beat sold off {pct(n.reaction_pct)}</span>}{" "}
        <span className="small muted">reported {dayLabel(s.reportDate)} {s.timing.replace("_", " ")} · {n.cap_group} · {n.sector ?? "sector ?"}</span>
      </div>
      <div className="small">
        EPS <b>{n.eps_actual}</b> vs {n.eps_consensus} consensus <span className="muted">(frozen {n.consensus_captured_at ? etLabelAgo(n.consensus_captured_at) : "?"})</span> · surprise rank <b>{n.surprise_pct_rank ?? "?"}</b> · <span title={n.revenue_source ?? "Revenue and its consensus were in neither Finnhub nor Financial Modeling Prep"}>revenue {n.revenue_beat === null ? "not checked" : `${n.revenue_beat ? "beat" : "missed"} (${pct(n.revenue_surprise_pct)})`}</span> · reaction <b>{pct(n.reaction_pct)}</b> vs SPY on {n.volume_ratio}× volume · run-up 10d {pct(n.runup_10d_pct)} (rank {n.runup_pct_rank ?? "?"}) · {n.days_after_quarter_end ?? "?"} days after quarter end · ${n.market_cap_b}B
      </div>
      {d && <div className="small muted">Guidance by wording (no model): {d.guidanceNumeric} · {d.pressUrl ? <a href={d.pressUrl} target="_blank" rel="noreferrer">press release read</a> : "press release not found"} · {d.headlines.length} headline(s) before entry</div>}
      {k && s.fixed && <div className="small warn">The card below was written from the first measurement: what it says about the reaction and the run-up used the second day&apos;s numbers and does not hold. The numbers above are the corrected ones.</div>}
      {k && (
        <>
          <div className="small">Beat quality <b className={k.beat_quality === "high" ? "pos" : k.beat_quality === "low" ? "neg" : "warn"}>{k.beat_quality}</b> ({k.beat_drivers.join(", ") || "?"}) · guidance <b>{k.guidance}</b> · confidence {k.confidence}{k.red_flags.length ? <span className="neg"> · red flags: {k.red_flags.join("; ")}</span> : null}</div>
          <div>{k.thesis}</div>
          {k.unknowns.length > 0 && <div className="small muted">Could not check: {k.unknowns.join("; ")}</div>}
        </>
      )}
      <div className="small">
        Paper: entry {t?.entryDate ?? "?"}{t?.entryPrice ? ` @ $${t.entryPrice.toFixed(2)}` : " (next open)"} · exit {t?.exitDate ?? "?"} {t?.nextKnown ? `(day before the confirmed ${t.nextReport} report)` : "(day before the estimated next report, or 60 sessions)"}
        {t?.closed ? <> · <b>closed {pct(t.retPct)}</b> (SPY {pct(t.spyPct)}; {t.exitBasis})</> : null}
      </div>
      <div className="small" style={{ marginTop: 4 }}>
        {t?.tappedAt ? <span className="tag ok">sent to Swing ideas {etLabelAgo(t.tappedAt)}</span> : k?.ai_recommendation === "promote" && !t?.closed ? <EarningsSend id={s.id} /> : null}
        {" "}{!k && isA(s.setup) && !measuredLate(s) ? <EarningsResearch id={s.id} symbol={s.symbol} /> : (
          <ResearchButton symbol={s.symbol} term={`${s.symbol} after earnings`} kind="event" from={{ label: "Earnings drift", url: "/earnings" }}
            observation={`${s.symbol} reported ${s.reportDate} (${s.timing.replace("_", " ")}): EPS ${n.eps_actual} vs ${n.eps_consensus} consensus (surprise rank ${n.surprise_pct_rank ?? "?"} of 100 in its size group)${measuredLate(s) ? "" : `, ${n.reaction_pct > 0 ? "+" : ""}${n.reaction_pct}% vs SPY on the reaction day on ${n.volume_ratio ?? "?"}x volume`}. The scout's earnings-drift screen lists it as setup ${s.setup}. Is there still a trade after this report, and which way?`} />
        )}
      </div>
      {/* The report shows as an earnings line; the paper entry (and exit once closed) as markers. */}
      <div style={{ marginTop: 10 }}><StockChart symbol={s.symbol} tvSymbol={tvSymbol(s.symbol)} height={440} entry={t?.entryDate ? { date: t.entryDate, price: t.entryPrice, direction: "long", label: "paper entry", ...(t.closed && t.exitDate ? { exitDate: t.exitDate, exitPrice: t.exitPrice } : {}) } : undefined} /></div>
    </section>
  );
}

function Scoreboard({ scans, tracks, cards, docs }: { scans: ScanRow[]; tracks: TrackRow[]; cards: CardRow[]; docs: DocRow[] }) {
  const scanBy = new Map(scans.map((s) => [s.id, s]));
  const cardBy = new Map(cards.map((c) => [c.scanId, c.card]));
  const docBy = new Map(docs.map((d) => [d.scanId, d]));
  const closed = tracks.filter((t) => t.closed && t.retPct !== null && scanBy.has(t.scanId));
  // The benchmark: every closed report's own excess over SPY, averaged by size group and report week.
  const bench = peerBench(closed.map((t) => { const s = scanBy.get(t.scanId)!; return { scanId: t.scanId, capGroup: s.numbers.cap_group, week: weekOf(s.reportDate), excess: t.spyPct !== null ? t.retPct! - t.spyPct : null, excessFromClose: t.retClosePct !== null && t.spyClosePct !== null ? t.retClosePct - t.spyClosePct : null }; }));
  const rows = closed.filter((t) => scanBy.get(t.scanId)!.setup).map((t) => {
    const s = scanBy.get(t.scanId)!, b = bench.get(t.scanId)!;
    const ex = t.spyPct !== null ? t.retPct! - t.spyPct : null, exC = t.retClosePct !== null && t.spyClosePct !== null ? t.retClosePct - t.spyClosePct : null;
    return { s, t, c: cardBy.get(t.scanId), d: docBy.get(t.scanId), x: { ret: t.retPct!, spy: t.spyPct, vsPeer: ex !== null && b.bench !== null ? ex - b.bench : null, vsPeerClose: exC !== null && b.benchClose !== null ? exC - b.benchClose : null, week: weekOf(s.reportDate) } };
  });
  const versions = [...new Set(rows.map((r) => r.s.version))];
  const quarterOf = (d: string) => `${d.slice(0, 4)} Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  const groups = (xs: typeof rows): Group[] => {
    const A = xs.filter((r) => isA(r.s.setup));
    const numeric = A.filter((r) => r.s.numbers.revenue_beat === true && r.d?.guidanceNumeric !== "cut");
    const quarters = [...new Set(A.map((r) => quarterOf(r.s.reportDate)))].sort();
    return [
      score("Rule only (every A-setup)", A.map((r) => r.x)),
      score("Numeric baseline: rule + revenue beat + no guidance cut (by wording)", numeric.map((r) => r.x)),
      score("Rule + AI promoted", A.filter((r) => r.c?.ai_recommendation === "promote").map((r) => r.x)),
      score("AI log-only (rejected)", A.filter((r) => r.c && r.c.ai_recommendation !== "promote").map((r) => r.x)),
      score("You sent to Swing", A.filter((r) => r.t.tappedAt).map((r) => r.x)),
      score("Tier A", A.filter((r) => r.s.setup === "A").map((r) => r.x)), score("Tier A+", A.filter((r) => r.s.setup === "A+").map((r) => r.x)), score("Tier A++", A.filter((r) => r.s.setup === "A++").map((r) => r.x)),
      score("Beat quality high", A.filter((r) => r.c?.beat_quality === "high").map((r) => r.x)), score("Beat quality mixed", A.filter((r) => r.c?.beat_quality === "mixed").map((r) => r.x)), score("Beat quality low", A.filter((r) => r.c?.beat_quality === "low").map((r) => r.x)),
      score("Study A0 (big beat, quiet volume)", xs.filter((r) => r.s.setup === "A0").map((r) => r.x)),
      score("Study B (short)", xs.filter((r) => r.s.setup === "B").map((r) => r.x), true), score("Study C (short)", xs.filter((r) => r.s.setup === "C").map((r) => r.x), true),
      score("Study D (big beat sold off, short)", xs.filter((r) => r.s.setup === "D").map((r) => r.x), true),
      ...quarters.map((qq) => score(`A-setups reported ${qq}`, A.filter((r) => quarterOf(r.s.reportDate) === qq).map((r) => r.x))),
    ];
  };
  return (
    <section className="card section">
      <h2>Scoreboard</h2>
      <p className="small secondary">Closed paper trades, entry to exit. &quot;vs peers&quot; = the trade&apos;s excess over SPY minus the average excess of the other reports in its size group and report week (each tracked the same way). The t-stat is clustered by report week (each week&apos;s average counts once), because trades in the same season move together.</p>
      <p className="small secondary"><b>How to read it.</b> Year 1 is an implementation check: are the numbers sane, does the rule-only return fall inside the research&apos;s range of annual results (which included flat and negative years), and do the data and costs hold up? Pass or fail needs a clustered t above 2 on 2-3 years of one frozen version. The AI comparisons (promoted vs rejected, and vs the numeric baseline) are directional until then: with about 100 rejects the standard error of the difference is around 2-3 points.</p>
      {rows.length === 0 ? <p className="small muted">No closed trades yet. The first exits come about 60 trading days after the first setups.</p> : versions.map((v) => {
        const g = groups(rows.filter((r) => r.s.version === v));
        const rule = g[0];
        return (
          <div key={v}>
            <h3 className="small">Version {v}</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Group</th><th className="num">Closed</th><th className="num">Weeks</th><th className="num">Win vs SPY</th><th className="num">Mean vs SPY</th><th className="num">Median vs SPY</th><th className="num">Mean vs peers</th><th className="num">… from reaction close</th><th className="num">t (by week)</th></tr></thead>
              <tbody>{g.filter((x) => x.n > 0).map((x) => <tr key={x.label}><td className="small">{x.label}</td><td className="num">{x.n}</td><td className="num">{x.weeks}</td><td className="num">{x.win ?? "?"}%</td><td className="num">{pct(x.meanSpy, 2)}</td><td className="num">{pct(x.medianSpy, 2)}</td><td className="num">{pct(x.meanPeer, 2)}</td><td className="num">{pct(x.meanPeerFromClose, 2)}</td><td className="num">{x.tClustered ?? "?"}</td></tr>)}</tbody>
            </table></div>
            <p className="small"><b>Status:</b> {rule.weeks < 50 ? `implementation check (${rule.n} closed A-setups over ${rule.weeks} report weeks); not a verdict.` : (rule.tClustered ?? 0) > 2 ? "clustered t above 2; confirm it holds on a second frozen year before calling it." : "no significant edge yet on this version."}</p>
          </div>
        );
      })}
    </section>
  );
}
