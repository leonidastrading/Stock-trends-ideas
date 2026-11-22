import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { groupStats, HOT2, HOT3, PR, prGroup, prRows, SINKERS, type PrGroup, type PrRow } from "@/lib/scout/pr-desk";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GROUP: Record<PrGroup, string> = { hot_small: `hot keywords, under ${PR.smallSharesM}M shares`, hot: "hot keywords, larger or unknown share count", old_news: "old news told again (an earlier headline on the same story)", plain: "no hot keywords", earnings: "earnings results", sinker: "offering / dilution / bad words" };
const pct = (a: number | null, b: number | null) => (a && b ? (b / a - 1) * 100 : null);
const fmt = (x: number | null, digits = 1) => (x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(digits)}%`);
const cls = (x: number | null) => (x === null ? "muted" : x > 0 ? "pos" : x < 0 ? "neg" : "");
const time = (iso: string) => { const e = toEt(new Date(iso)); return `${String(Math.floor(e.minutes / 60) % 12 || 12)}:${String(e.minutes % 60).padStart(2, "0")} ${e.minutes < 720 ? "AM" : "PM"}`; };
const delay = (a: string, b: string) => { const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)); return s < 60 ? `+${s}s` : s < 3600 ? `+${Math.floor(s / 60)}m ${s % 60}s` : `+${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const money = (x: number | null) => (x === null ? "—" : `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`);

function Release({ r }: { r: PrRow }) {
  const g = prGroup(r);
  return (
    <section className="card pr-item">
      <div className="pr-head">
        <Ticker symbol={r.symbol} />
        {r.stars > 0 && <span className={`tag ${r.stars >= 3 ? "ok" : ""}`}>{r.stars} pts</span>}
        {r.hot.map((w) => <span key={w} className="tag">{w}</span>)}
        {r.sinkers.map((w) => <span key={w} className="tag error">{w}</span>)}
        {r.earnings && <span className="tag">earnings</span>}
        {r.sharesOutM !== null && <span className={`tag ${r.sharesOutM <= PR.smallSharesM ? "ok" : ""}`}>{r.sharesOutM}M shares</span>}
        <span className="small muted">{toEt(new Date(r.seenAt)).date} · {GROUP[g]}</span>
      </div>
      {r.earlier && <div className="small warn">Old news: first reported {toEt(new Date(r.earlier.at)).date} {time(r.earlier.at)} ET by {r.earlier.source || "another outlet"} (&quot;{r.earlier.headline.slice(0, 140)}&quot;). The feed dates this re-write, not the news.</div>}
      <div className="pr-headline">{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.headline}</a> : r.headline} <span className="small muted">{r.source}</span></div>
      <div className="pr-grid small">
        <div>
          <div className="pr-label">Timeline (ET)</div>
          <div className="pr-row"><span>Published</span><span>{time(r.publishedAt)}</span></div>
          <div className="pr-row"><span>Scout saw it</span><span>{time(r.seenAt)} <span className="muted">{delay(r.publishedAt, r.seenAt)}</span></span></div>
        </div>
        <div>
          <div className="pr-label">Price</div>
          <div className="pr-row"><span>Previous close</span><span>{money(r.prevClose)}</span></div>
          <div className="pr-row"><span>When published</span><span>{money(r.pricePub)} <span className={cls(pct(r.prevClose, r.pricePub))}>{fmt(pct(r.prevClose, r.pricePub))}</span></span></div>
          <div className="pr-row"><span>When the scout saw it</span><span>{money(r.priceSeen)} <span className={cls(pct(r.pricePub, r.priceSeen))}>{r.pricePub ? `${fmt(pct(r.pricePub, r.priceSeen))} from the news` : ""}</span></span></div>
          {r.vol60 !== null && <div className="pr-row"><span>Volume, first hour after</span><span>{Math.round(r.vol60).toLocaleString("en-US")} <span className="muted">(IEX)</span></span></div>}
        </div>
        <div>
          <div className="pr-label">From when the scout saw it</div>
          <div className="pr-row"><span>+15 min</span><span className={cls(pct(r.priceSeen, r.p15))}>{r.p15 === null ? "pending" : `${fmt(pct(r.priceSeen, r.p15))} ${money(r.p15)}`}</span></div>
          <div className="pr-row"><span>+60 min</span><span className={cls(pct(r.priceSeen, r.p60))}>{r.p60 === null ? "pending" : `${fmt(pct(r.priceSeen, r.p60))} ${money(r.p60)}`}</span></div>
          {r.high60 !== null && <div className="pr-row"><span>Best price in that hour</span><span className="muted">{fmt(pct(r.priceSeen, r.high60))}</span></div>}
          <div className="pr-row"><span>That session&apos;s close</span><span className={cls(pct(r.priceSeen, r.dayClose))}>{r.dayClose === null ? "pending" : `${fmt(pct(r.priceSeen, r.dayClose))} ${money(r.dayClose)}`}</span></div>
          <div className="pr-row"><span>Next close</span><span className={cls(pct(r.priceSeen, r.nextClose))}>{r.nextClose === null ? "pending" : `${fmt(pct(r.priceSeen, r.nextClose))} ${money(r.nextClose)}`}</span></div>
        </div>
      </div>
    </section>
  );
}

/** Press releases: a forward test of the "hot press release" method, with the delays and what followed. */
export default async function PrsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const rows = await prRows(30).catch(() => [] as PrRow[]);
  const stats = groupStats(rows);
  const recent = rows.filter((r) => Date.now() - Date.parse(r.seenAt) < 3 * 86400_000);
  const flagged = recent.filter((r) => r.stars >= 3 || r.sinkers.length);
  const others = recent.filter((r) => !(r.stars >= 3 || r.sinkers.length));
  const delays = rows.map((r) => (Date.parse(r.seenAt) - Date.parse(r.publishedAt)) / 1000).filter((x) => x >= 0).sort((a, b) => a - b);
  const medDelay = delays.length ? delays[Math.floor(delays.length / 2)] : null;
  return (
    <>
      <h1>Press releases</h1>
      <p className="small secondary">A forward test of the &quot;hot press release&quot; day-trading method: watch the waves of company news from 7:00 to 9:30 AM ET (heaviest at 8:00 and 8:30) and after the 4 PM close, read only the headline for hot words, prefer small floats, never touch an offering, and get in before the crowd. Every minute in those windows the scout logs each single-company headline with the method&apos;s keyword score, when it was published and when the scout saw it, and the price at both; later, the move 15 and 60 minutes on, that session&apos;s close and the next close. Shares outstanding (Finnhub) stand in for the float. The famous runners are famous because they ran; this measures all of them. Paper only, no AI.</p>

      <section className="card">
        <h2>The test so far <span className="small muted">(last 30 days, from the price when the scout saw each headline)</span></h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Group</th><th className="num">Headlines</th><th className="num">+15 min</th><th className="num">+60 min</th><th className="num">Session close</th><th className="num">Next close</th><th className="num">Up at the close</th></tr></thead>
          <tbody>{stats.map((s) => <tr key={s.group}><td>{GROUP[s.group]}</td><td className="num">{s.n}</td><td className={`num ${cls(s.m15)}`}>{fmt(s.m15)}</td><td className={`num ${cls(s.m60)}`}>{fmt(s.m60)}</td><td className={`num ${cls(s.mClose)}`}>{fmt(s.mClose)}</td><td className={`num ${cls(s.mNext)}`}>{fmt(s.mNext)}</td><td className="num">{s.upClose === null ? "—" : `${s.upClose}%`}</td></tr>)}</tbody>
        </table></div>
        <p className="small muted">The method says &quot;hot keywords, small share count&quot; should beat the rest and offerings should fall. Averages of a few dozen headlines swing a lot (one runner moves the mean); give it weeks. {medDelay !== null ? <>The scout saw headlines a median {Math.round(medDelay)} seconds after publication: much of a first-minute spike happens before that, which is the method&apos;s whole edge.</> : null}</p>
      </section>

      <h2>Hot or flagged headlines, last 3 days <span className="small muted">({flagged.length})</span></h2>
      {flagged.length === 0 ? <p className="small muted">None yet. Logging runs on weekdays from 6:55 to 9:40 AM and 3:55 to 6:30 PM ET.</p> : flagged.map((r) => <Release key={r.id} r={r} />)}
      {others.length > 0 && (
        <details className="card"><summary>Other headlines in the windows ({others.length})</summary>
          <div className="table-wrap"><table><thead><tr><th>Seen</th><th>Stock</th><th>Headline</th><th className="num">Pts</th><th className="num">+60 min</th><th className="num">Close</th></tr></thead>
            <tbody>{others.slice(0, 300).map((r) => <tr key={r.id}><td className="small">{time(r.seenAt)}</td><td><Ticker symbol={r.symbol} /></td><td className="small">{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.headline}</a> : r.headline}</td><td className="num">{r.stars}</td><td className={`num ${cls(pct(r.priceSeen, r.p60))}`}>{fmt(pct(r.priceSeen, r.p60))}</td><td className={`num ${cls(pct(r.priceSeen, r.dayClose))}`}>{fmt(pct(r.priceSeen, r.dayClose))}</td></tr>)}</tbody>
          </table></div>
        </details>
      )}
      <details className="card small"><summary><b>The keyword list</b></summary>
        <p><b>Three-star (3 pts):</b> {HOT3.join(", ")}.</p>
        <p><b>Two-star (2 pts):</b> {HOT2.join(", ")}.</p>
        <p><b>Stay away:</b> {SINKERS.join(", ")}.</p>
      </details>
    </>
  );
}
