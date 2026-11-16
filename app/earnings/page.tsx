import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { allCards, allTracks, EARN, EARN_VERSION, historyCount, isA, scansSince, score, type CardRow, type Group, type ScanRow, type TrackRow } from "@/lib/scout/earnings";
import { calendarDay } from "@/lib/sources/earnings-data";
import { addDays, etLabel, toEt } from "@/lib/time";
import EarningsSend from "./EarningsSend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIER: Record<string, number> = { "A++": 0, "A+": 1, A: 2 };
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "?" : `${x > 0 ? "+" : ""}${x.toFixed(d)}%`);
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Earnings drift (up): the nightly earnings scan, its setups, open paper positions, rejected candidates and the scoreboard. */
export default async function EarningsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const data = marketDataFromEnv();
  const today = toEt(new Date()).date;
  const [scans, tracks, cards, history, backfill] = await Promise.all([scansSince(400), allTracks(), allCards(), historyCount().catch(() => 0), import("@/lib/scout/store").then((s) => s.cacheGet<{ next: string; floor: string }>("earnings:backfill")).catch(() => null)]);
  const trackBy = new Map(tracks.map((t) => [t.scanId, t]));
  const cardBy = new Map(cards.map((c) => [c.scanId, c]));
  const recent = scans.filter((s) => s.reactionDate >= addDays(today, -14));
  const aRecent = recent.filter((s) => isA(s.setup)).sort((x, y) => {
    const cx = cardBy.get(x.id)?.card, cy = cardBy.get(y.id)?.card;
    const px = cx?.ai_recommendation === "promote" ? 0 : cx ? 1 : 2, py = cy?.ai_recommendation === "promote" ? 0 : cy ? 1 : 2;
    return px - py || TIER[x.setup!] - TIER[y.setup!] || y.reactionDate.localeCompare(x.reactionDate);
  });
  const study = scans.filter((s) => (s.setup === "B" || s.setup === "C") && s.reactionDate >= addDays(today, -30));
  const rejected = recent.filter((s) => !s.setup && s.reason && !/^surprise rank/.test(s.reason));
  const open = tracks.filter((t) => !t.closed);
  const scanBy = new Map(scans.map((s) => [s.id, s]));
  // Latest prices for the open positions (read-only market data).
  const snaps = data?.getSnapshots && open.length ? await data.getSnapshots([...new Set(["SPY", ...open.map((t) => scanBy.get(t.scanId)?.symbol).filter((x): x is string => !!x)])]).catch(() => ({})) : {};
  // This week's calendar: reports in the universe's market-cap range, per day.
  const week = data ? await (async () => {
    const sessions = (await data.getCalendar(today, addDays(today, 10)).catch(() => [])).map((s) => s.date).slice(0, 5);
    return Promise.all(sessions.map(async (d) => ({ d, n: (await calendarDay(d).catch(() => [])).filter((r) => r.marketCap !== null && r.marketCap >= EARN.minCap && r.marketCap < EARN.maxCap).length })));
  })().catch(() => []) : [];

  return (
    <>
      <h1>Drift</h1>
      <div className="toolbar"><span className="filter-links small"><a className="chip" href="/drift">Down drift (bad news)</a><a className="chip active" href="/earnings">Earnings drift (up)</a></span></div>
      <details className="card section">
        <summary><b>How this works</b> <span className="small muted">big earnings beats that keep drifting up for ~60 trading days</span></summary>
        <div className="small secondary">
          <p>Every night after the close the scout checks every US earnings report whose reaction day just ended (before-open reports: that day; after-close: the next day). Universe: US stocks, price ${EARN.minPrice}+, market cap $1B-$200B, enough trading; consumer staples, utilities, communication services and real estate left out.</p>
          <ul>
            <li><b>A</b>: the biggest beats, the top 20% by (actual EPS − consensus) ÷ price against the last 12 months of reports in the same size group (under $2B, $2-10B, $10-200B), with reaction-day volume at least {EARN.minVolumeRatio}× normal. <b>A+</b>: reported within {EARN.earlyDays} days of quarter end. <b>A++</b>: also in the top third by 10-day run-up before the report.</li>
            <li><b>B</b> (study only): a $1-10B company that missed and gapped up more than {EARN.gapPct}%. <b>C</b> (study only): a $10B+ company below last year&apos;s EPS that gapped down more than {EARN.gapPct}%. Logged as paper shorts, never promoted.</li>
            <li>Paper entry: the next open. Exit: the close of the day before the next report (moved to the real date once it is on the calendar), or 60 trading days. No stop; the worst drawdown is logged.</li>
            <li>For each A-setup the AI reads the press release (SEC 8-K) and the headlines and judges the beat: high quality (revenue beat, guidance up, margins up) or low (tax, buybacks, one-offs, guidance cut). The numbers come from the feeds; the AI cannot change them. Every A-setup is tracked whether or not the AI promotes it, so &quot;rule only&quot; and &quot;rule + AI&quot; can be compared.</li>
          </ul>
          <p>Research basis: 2015-2026, ~63,000 reports; the big-beat drift was about +1.2% over 60 days vs the average report (+1.7% with the filters), lumpy, about half the trades win. It needs ~300 closed A-setups (about a year) before the result means anything.</p>
          <p>Data: Nasdaq earnings calendar (consensus and actual EPS, timing, market cap, quarter end), Nasdaq sector, Alpaca prices (the volume is IEX-only, so the liquidity floor is ${(EARN.minIexDollarVolume / 1e6).toFixed(1)}M a day on IEX, about $10M overall), revenue from Finnhub when FINNHUB_API_KEY is set (otherwise cards say revenue was not checked), press releases from the SEC.</p>
          <p className="muted">Version {EARN_VERSION}. Surprise history: {history.toLocaleString("en-US")} reports{backfill?.data ? (backfill.data.next < backfill.data.floor ? " (full year loaded)" : `, loading back to ${backfill.data.floor} (now at ${backfill.data.next}); ranks count once a size group has ${EARN.minHistory}+ reports`) : ", loading starts with the hourly job"}.</p>
        </div>
      </details>

      {week.length > 0 && (
        <div className="card section small">
          <b>This week:</b> {week.map((w) => <span key={w.d} style={{ marginRight: 14 }}>{dayLabel(w.d)} <b>{w.n}</b></span>)}
          <span className="muted"> reports from $1-200B companies; roughly 1 in 5 beats big enough to be an A-setup (fewer after the sector and volume filters).</span>
        </div>
      )}

      <h2>Setups (last 14 days)</h2>
      {aRecent.length === 0 && <p className="small muted">No A-setups in the last 14 days{history < 300 ? " (the surprise history is still loading, so ranks may not count yet)" : ""}.</p>}
      {aRecent.map((s) => <SetupCard key={s.id} s={s} t={trackBy.get(s.id) ?? null} c={cardBy.get(s.id) ?? null} />)}

      <h2>Open paper positions ({open.length})</h2>
      {open.length === 0 ? <p className="small muted">None yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Stock</th><th>Setup</th><th>Entry</th><th className="num">Held</th><th className="num">Return</th><th className="num">vs SPY</th><th>Exit</th></tr></thead>
          <tbody>{open.map((t) => {
            const s = scanBy.get(t.scanId);
            if (!s) return null;
            const snap = (snaps as Record<string, { price?: number }>)[s.symbol];
            const spyNow = (snaps as Record<string, { price?: number }>).SPY?.price;
            const ret = t.entryPrice && snap?.price ? (snap.price / t.entryPrice - 1) * 100 : null;
            const held = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${t.entryDate}T12:00:00Z`)) / 86400_000));
            const toExit = t.exitDate ? Math.round((Date.parse(`${t.exitDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400_000) : null;
            return (
              <tr key={t.scanId}>
                <td><Ticker symbol={s.symbol} className={isA(s.setup) ? "pos" : "neg"} />{t.tappedAt ? <span className="tag ok">sent</span> : null}</td>
                <td className="small">{s.setup}{s.setup === "B" || s.setup === "C" ? " (short, study)" : ""}</td>
                <td className="small">{t.entryDate}{t.entryPrice ? ` @ $${t.entryPrice.toFixed(2)}` : " (next open)"}</td>
                <td className="num small">{held}d</td>
                <td className={`num small ${ret !== null && ret >= 0 ? "pos" : "neg"}`}>{pct(ret)}</td>
                <td className="num small muted">{spyNow ? "live" : ""}</td>
                <td className="small">{t.exitDate ?? "?"}{toExit !== null ? <span className="muted"> ({toExit}d{t.nextKnown ? `, report ${t.nextReport}` : ", report date estimated"})</span> : null} {t.worstPct !== null ? <span className="muted">· worst {pct(t.worstPct)}</span> : null}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}

      {study.length > 0 && (
        <details className="card section">
          <summary><b>Study setups B and C (last 30 days, {study.length})</b> <span className="small muted">logged as paper shorts, never promoted</span></summary>
          <ul className="small">{study.map((s) => <li key={s.id}><Ticker symbol={s.symbol} className="neg" /> <b>{s.setup}</b> · reported {s.reportDate} · EPS {s.numbers.eps_actual} vs {s.numbers.eps_consensus} · reaction {pct(s.numbers.reaction_pct)} · ${s.numbers.market_cap_b}B {s.numbers.sector ?? ""}</li>)}</ul>
        </details>
      )}

      <details className="card section">
        <summary><b>Candidates rejected (last 14 days, {rejected.length})</b> <span className="small muted">reports that came close, and why they did not count</span></summary>
        {rejected.length === 0 ? <p className="small muted">None.</p> : <ul className="small">{rejected.map((s) => <li key={s.id}><Ticker symbol={s.symbol} /> reported {s.reportDate} · EPS {s.numbers.eps_actual} vs {s.numbers.eps_consensus} (rank {s.numbers.surprise_pct_rank ?? "?"}) · reaction {pct(s.numbers.reaction_pct)} · <span className="warn">{s.reason}</span></li>)}</ul>}
      </details>

      <Scoreboard scans={scans} tracks={tracks} cards={cards} />
    </>
  );
}

function SetupCard({ s, t, c }: { s: ScanRow; t: TrackRow | null; c: CardRow | null }) {
  const n = s.numbers, k = c?.card;
  return (
    <section className="card earnings-card">
      <div>
        <Ticker symbol={s.symbol} className="pos" /> <span className="tag late">{s.setup}</span>{" "}
        {k ? <span className={`tag ${k.ai_recommendation === "promote" ? "ok" : ""}`}>{k.ai_recommendation === "promote" ? "promoted" : "log only"}</span> : <span className="tag">card waiting</span>}{" "}
        <span className="small muted">reported {dayLabel(s.reportDate)} {s.timing.replace("_", " ")} · {n.cap_group} · {n.sector ?? "sector ?"}</span>
      </div>
      <div className="small">
        EPS <b>{n.eps_actual}</b> vs {n.eps_consensus} consensus (surprise rank <b>{n.surprise_pct_rank ?? "?"}</b>) · revenue {n.revenue_actual !== null && n.revenue_consensus !== null ? `${pct(n.revenue_surprise_pct)} vs consensus` : "not checked"} · reaction <b>{pct(n.reaction_pct)}</b> vs SPY on {n.volume_ratio}× volume · run-up 10d {pct(n.runup_10d_pct)} · {n.days_after_quarter_end ?? "?"} days after quarter end · ${n.market_cap_b}B
      </div>
      {k && (
        <>
          <div className="small">Beat quality <b className={k.beat_quality === "high" ? "pos" : k.beat_quality === "low" ? "neg" : "warn"}>{k.beat_quality}</b> ({k.beat_drivers.join(", ") || "?"}) · guidance <b>{k.guidance}</b> · confidence {k.confidence}{k.red_flags.length ? <span className="neg"> · red flags: {k.red_flags.join("; ")}</span> : null}</div>
          <div>{k.thesis}</div>
          {k.unknowns.length > 0 && <div className="small muted">Could not check: {k.unknowns.join("; ")}</div>}
        </>
      )}
      <div className="small">
        Paper: entry {t?.entryDate ?? "?"}{t?.entryPrice ? ` @ $${t.entryPrice.toFixed(2)}` : " (next open)"} · exit {t?.exitDate ?? "?"} {t?.nextKnown ? `(day before the ${t.nextReport} report)` : "(day before the expected next report, or 60 trading days)"}
        {t?.closed ? <> · <b>closed {pct(t.retPct)}</b> (SPY {pct(t.spyPct)}, peers {pct(t.peerPct)})</> : null}
      </div>
      <div className="small" style={{ marginTop: 4 }}>
        {t?.tappedAt ? <span className="tag ok">sent to Swing ideas {etLabel(t.tappedAt)}</span> : k?.ai_recommendation === "promote" && !t?.closed ? <EarningsSend id={s.id} /> : null}
      </div>
    </section>
  );
}

function Scoreboard({ scans, tracks, cards }: { scans: ScanRow[]; tracks: TrackRow[]; cards: CardRow[] }) {
  const scanBy = new Map(scans.map((s) => [s.id, s]));
  const cardBy = new Map(cards.map((c) => [c.scanId, c.card]));
  const closed = tracks.filter((t) => t.closed && t.retPct !== null).map((t) => ({ t, s: scanBy.get(t.scanId)!, c: cardBy.get(t.scanId) })).filter((x) => x.s);
  const row = (x: { t: TrackRow }) => ({ ret: x.t.retPct!, spy: x.t.spyPct, peer: x.t.peerPct });
  const versions = [...new Set(closed.map((x) => x.s.version))];
  const groups = (xs: typeof closed): Group[] => {
    const A = xs.filter((x) => isA(x.s.setup));
    const quarters = [...new Set(A.map((x) => `${x.t.exitDate?.slice(0, 4)} Q${Math.floor((Number(x.t.exitDate?.slice(5, 7)) - 1) / 3) + 1}`))].sort();
    return [
      score("Rule only (every A-setup)", A.map(row)),
      score("Rule + AI promoted", A.filter((x) => x.c?.ai_recommendation === "promote").map(row)),
      score("AI log-only (rejected)", A.filter((x) => x.c && x.c.ai_recommendation !== "promote").map(row)),
      score("You sent to Swing", A.filter((x) => x.t.tappedAt).map(row)),
      score("Tier A", A.filter((x) => x.s.setup === "A").map(row)), score("Tier A+", A.filter((x) => x.s.setup === "A+").map(row)), score("Tier A++", A.filter((x) => x.s.setup === "A++").map(row)),
      score("Beat quality high", A.filter((x) => x.c?.beat_quality === "high").map(row)), score("Beat quality mixed", A.filter((x) => x.c?.beat_quality === "mixed").map(row)), score("Beat quality low", A.filter((x) => x.c?.beat_quality === "low").map(row)),
      score("Study B (short)", xs.filter((x) => x.s.setup === "B").map(row), true), score("Study C (short)", xs.filter((x) => x.s.setup === "C").map(row), true),
      ...quarters.map((qq) => score(`A-setups closed ${qq}`, A.filter((x) => `${x.t.exitDate?.slice(0, 4)} Q${Math.floor((Number(x.t.exitDate?.slice(5, 7)) - 1) / 3) + 1}` === qq).map(row))),
    ];
  };
  return (
    <section className="card section">
      <h2>Scoreboard</h2>
      <p className="small secondary">Closed paper trades, entry to exit. Excess vs SPY, and vs the average report in the same size group that week (the research&apos;s benchmark). Verdict rules: pass only when rule-only excess vs peers is positive with t above 2 over about 300 closed A-setups; the AI counts as useful only if promoted ideas beat rejected ones by at least 1 point.</p>
      {closed.length === 0 ? <p className="small muted">No closed trades yet. The first exits come about 60 trading days after the first setups.</p> : versions.map((v) => {
        const g = groups(closed.filter((x) => x.s.version === v));
        const rule = g[0], prom = g[1], rej = g[2];
        return (
          <div key={v}>
            <h3 className="small">Version {v}</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Group</th><th className="num">Closed</th><th className="num">Win vs SPY</th><th className="num">Mean vs SPY</th><th className="num">Median vs SPY</th><th className="num">Mean vs peers</th><th className="num">t (vs peers)</th></tr></thead>
              <tbody>{g.filter((x) => x.n > 0).map((x) => <tr key={x.label}><td className="small">{x.label}</td><td className="num">{x.n}</td><td className="num">{x.win ?? "?"}%</td><td className="num">{pct(x.meanSpy, 2)}</td><td className="num">{pct(x.medianSpy, 2)}</td><td className="num">{pct(x.meanPeer, 2)}</td><td className="num">{x.t ?? "?"}</td></tr>)}</tbody>
            </table></div>
            <p className="small">
              <b>Verdict:</b> {rule.n < 300 ? `too early (${rule.n} of ~300 closed A-setups).` : rule.meanPeer !== null && rule.meanPeer > 0 && (rule.t ?? 0) > 2 ? "the rule passes (positive vs peers, t above 2)." : "the rule does not pass yet."}{" "}
              {prom.n >= 30 && rej.n >= 30 && prom.meanPeer !== null && rej.meanPeer !== null ? (prom.meanPeer - rej.meanPeer >= 1 ? "The AI's promotion adds value (promoted beat rejected by 1+ point)." : "The AI's promotion does not add value yet.") : "Not enough promoted and rejected trades to judge the AI."}
            </p>
          </div>
        );
      })}
    </section>
  );
}
