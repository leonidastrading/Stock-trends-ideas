import CardChips from "@/components/CardChips";
import ResearchButton from "@/components/ResearchButton";
import Ticker from "@/components/Ticker";
import type { CardBrief } from "@/lib/scout/store";
import { moverOutcome, moverRows, themeSummary, type MoverRow, type ThemeSummary } from "@/lib/scout/bubble-run";
import { fmtEtAgo } from "@/lib/time";

const pct = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`);
const LEVEL: Record<string, [string, string]> = { mania: ["mania", "error"], building: ["building", "late"], quiet: ["quiet", ""] };

function observation(r: MoverRow): string {
  return `Possible hype bubble: ${r.symbol}${r.theme ? ` (${r.theme})` : ""} is going parabolic${r.why ? `: ${r.why}` : ""}. Measured now: ${pct(r.run30)} in 30 days (${r.sigmas30 ?? "?"} standard deviations of its own normal moves), ${pct(r.run5)} in 5 days, ${pct(r.ext50)} above its 50-day average, volume ${r.volRatio ?? "?"}x normal${r.perHour !== null ? `, Stocktwits ${r.perHour} messages/hour${r.z !== null ? ` (${r.z > 0 ? "+" : ""}${r.z} sigma vs its normal)` : ""}` : ""}. Research whether this is hype that is close to topping (buyers already in, the story priced, attention peaking) or a move with real news behind it that can keep running. Say what is priced, how crowded it is, what would end it (a share sale, a missed date, a broken story), and the timing risk: shorting a parabolic move early can be very painful, so say when a fade would be entered, if at all, or why to stay away.`;
}

/** Bubbles' hype runs: hot themes, stocks going parabolic now, and how past runs ended. */
export default async function Movers({ briefs }: { briefs: CardBrief[] }) {
  const [rows, themes] = await Promise.all([moverRows(120).catch(() => [] as MoverRow[]), themeSummary()]);
  const live = rows.filter((r) => Date.now() - Date.parse(r.lastSeen) < 36 * 3600_000);
  const order = { mania: 0, building: 1, quiet: 2 } as const;
  live.sort((a, b) => order[a.level] - order[b.level] || (b.sigmas30 ?? 0) - (a.sigmas30 ?? 0));
  const ended = rows.filter((r) => r.priceAfter10 !== null).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
  const cardsOn = (s: string) => briefs.filter((c) => c.primaryTicker === s || c.tickers.includes(s));
  const hot = (themes?.data ?? []).filter((t) => t.level !== "quiet");
  const quiet = (themes?.data ?? []).filter((t) => t.level === "quiet");
  const done20 = ended.filter((r) => r.priceAfter20 !== null);
  const fell = done20.filter((r) => (moverOutcome(r, r.priceAfter20, r.spyAfter20) ?? 0) < 0).length;

  const theme = (t: ThemeSummary) => (
    <tr key={t.theme}>
      <td><b>{t.theme}</b>{t.fromNews ? <span className="small muted"> (in the news)</span> : null}{t.why ? <div className="small muted">{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.why}</a> : t.why}</div> : null}</td>
      <td><span className={`tag ${LEVEL[t.level][1]}`}>{LEVEL[t.level][0]}</span></td>
      <td className="num">{pct(t.median30)}</td>
      <td className="small">{t.members.map((m, i) => <span key={m.symbol}>{i ? " · " : ""}<Ticker symbol={m.symbol} /> <span className={m.level === "mania" ? "neg" : m.level === "building" ? "warn" : "muted"}>{pct(m.run30)}</span></span>)}</td>
    </tr>
  );

  return (
    <>
      <section className="card">
        <h2>Hot themes</h2>
        <p className="small muted">Whole groups running at once (quantum, AI, nuclear, space, crypto, oil, gold, memes and whatever the news says is hot), from each member&apos;s 30-day move. Colored moves are members building or in mania. {themes ? <>Checked {fmtEtAgo(themes.updatedAt)}.</> : "The first check runs within two hours."}</p>
        {hot.length === 0 ? <p className="small muted">{themes ? "No theme is running hot right now." : ""}</p> : (
          <div className="table-wrap"><table><thead><tr><th>Theme</th><th>Hype</th><th className="num">Median 30d</th><th>Members (30 days)</th></tr></thead><tbody>{hot.map(theme)}</tbody></table></div>
        )}
        {quiet.length > 0 && <details className="small"><summary>Quiet themes ({quiet.length})</summary><div className="table-wrap"><table><tbody>{quiet.map(theme)}</tbody></table></div></details>}
      </section>

      <section className="card">
        <h2>Parabolic now</h2>
        <p className="small muted">
          Stocks, ETFs and commodities going up fast on hype, with or without a date. Measured on each one&apos;s own scale, so a 20% month in oil counts like an 80% month in a quantum small cap: the 30-day move in standard deviations (σ) of its own normal daily moves. <span className="tag error">mania</span> a 3.5σ month that is still speeding up (most of the gain in the last two weeks), 20%+ above its 50-day average, with loud attention (Stocktwits far above normal or volume 3× normal). <span className="tag late">building</span> a 2.5σ month up. From the theme baskets, the news, Stocktwits trending and the day&apos;s top gainers.
        </p>
        {live.length === 0 ? <p className="small muted">Nothing parabolic right now{rows.length ? "" : " (or the first check has not run yet)"}.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>Why</th><th className="num">30 days</th><th className="num">5 days</th><th className="num">vs 50-day</th><th>Volume · attention</th><th>Hype</th><th>Since listed</th><th>Cards / research</th></tr></thead>
            <tbody>{live.map((r) => {
              const since = r.priceFirst && r.priceLast ? (r.priceLast / r.priceFirst - 1) * 100 : null;
              const cards = cardsOn(r.symbol);
              return (
                <tr key={r.id}>
                  <td><Ticker symbol={r.symbol} />{r.theme ? <div className="small muted">{r.theme}</div> : null}</td>
                  <td className="small">{r.why ? (r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.why}</a> : r.why) : <span className="muted">{r.source}</span>}</td>
                  <td className="num">{pct(r.run30)}<div className="small muted">{r.sigmas30 ?? "?"}σ</div></td>
                  <td className="num">{pct(r.run5)}</td>
                  <td className="num">{pct(r.ext50)}</td>
                  <td className="small">{r.volRatio !== null ? `${r.volRatio}× volume` : "—"}{r.perHour !== null ? <div className="muted">{r.perHour}/h Stocktwits{r.z !== null ? `, ${r.z > 0 ? "+" : ""}${r.z}σ` : ""}</div> : null}</td>
                  <td><span className={`tag ${LEVEL[r.level][1]}`}>{LEVEL[r.level][0]}</span></td>
                  <td className="small">{pct(since)}<div className="muted">{fmtEtAgo(r.firstSeen)}</div></td>
                  <td className="small">{cards.length > 0 && <CardChips cards={cards} max={4} />} <ResearchButton symbol={r.symbol} term={`bubble: ${r.symbol} parabolic`.slice(0, 80)} observation={observation(r)} kind="event" from={{ label: "Bubbles", url: "/bubbles" }} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      {ended.length > 0 && (
        <section className="card">
          <h2>How hype runs ended</h2>
          <p className="small muted">From the day each run was first listed: the move 10 sessions later, and 20 sessions later against SPY. {done20.length ? <>So far {fell} of {done20.length} lagged SPY over 20 sessions.</> : null} This is the honest test: the famous bubbles are famous because they popped.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>Listed</th><th>As</th><th className="num">10 sessions</th><th className="num">20 sessions vs SPY</th><th className="num">Peak while listed</th></tr></thead>
            <tbody>{ended.map((r) => {
              const a10 = r.priceFirst && r.priceAfter10 ? (r.priceAfter10 / r.priceFirst - 1) * 100 : null;
              const a20 = moverOutcome(r, r.priceAfter20, r.spyAfter20);
              const peak = r.priceFirst && r.peakPrice ? (r.peakPrice / r.priceFirst - 1) * 100 : null;
              return (
                <tr key={r.id}>
                  <td><Ticker symbol={r.symbol} />{r.theme ? <span className="small muted"> {r.theme}</span> : null}</td>
                  <td className="small">{fmtEtAgo(r.firstSeen)}</td>
                  <td><span className={`tag ${LEVEL[r.levelFirst][1]}`}>{LEVEL[r.levelFirst][0]}</span></td>
                  <td className={`num ${a10 === null ? "muted" : a10 < 0 ? "neg" : "pos"}`}>{pct(a10)}</td>
                  <td className={`num ${a20 === null ? "muted" : a20 < 0 ? "neg" : "pos"}`}>{a20 === null ? "waiting" : pct(a20)}</td>
                  <td className="num">{pct(peak)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
