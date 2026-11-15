import Gauge from "@/components/Gauge";
import { MoversTable, SocialTable } from "@/components/SocialTables";
import Ticker from "@/components/Ticker";
import { bySymbol } from "@/lib/scout/congress";
import { loadPanels } from "@/lib/scout/dashboard-warm";
import * as store from "@/lib/scout/store";
import { addDays, fmtEt, toEt } from "@/lib/time";

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const money = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);
const cap = (v: number | null) => (v === null ? "" : v >= 1e12 ? `$${(v / 1e12).toFixed(1)}T` : v >= 1e9 ? `$${Math.round(v / 1e9)}B` : `$${Math.round(v / 1e6)}M`);

function Head({ title, note, updatedAt, error }: { title: string; note?: string; updatedAt: string | null; error: string | null }) {
  return (
    <div className="panel-head">
      <span>{title}</span>
      <span className="small muted">{error && !updatedAt ? <span className="warn">{error}</span> : updatedAt ? `${note ? `${note} · ` : ""}${fmtEt(updatedAt)}` : note}</span>
    </div>
  );
}

function Bar({ left, right, share, color = "split" }: { left: React.ReactNode; right: React.ReactNode; share: number; color?: "split" | "mood" }) {
  return (
    <div className="statbar">
      <div className="statbar-labels small"><span>{left}</span><span>{right}</span></div>
      <div className={`statbar-track ${color}`}><span style={{ width: `${Math.max(0, Math.min(100, share))}%` }} /></div>
    </div>
  );
}

/** Market panels for the top of the Digest: breadth and mood, market and rates, earnings, federal contracts, buzz. */
export default async function MarketPanels() {
  const since = addDays(toEt(new Date()).date, -30);
  const [{ market, earnings, contracts, buzz, breadth, polymarket, movers, social }, congress, optionFlags, truth] = await Promise.all([
    loadPanels(),
    store.congressTradesSince(since).then((t) => bySymbol(t, since).filter((a) => a.buyers.length > 0).slice(0, 10)).catch(() => []),
    store.optionsFlagsSince(addDays(toEt(new Date()).date, -5)).catch(() => []),
    store.truthPostsSince(new Date(Date.now() - 3 * 86400_000).toISOString(), true).catch(() => []),
  ]);
  const posts = truth.filter((p) => p.read).sort((a, b) => (b.read!.urgency - a.read!.urgency) || b.at.localeCompare(a.at)).slice(0, 6);
  const b = breadth.data;
  return (
    <>
      <div className="gauges-row">
        <Gauge value={b?.mood ?? null} title="Fear & greed" note={b ? `Our own reading (not CNN's), the average of: ${b.parts}. From ${b.stocks} large US stocks' daily closes, SPY and Cboe's VIX; as of ${b.asOf}.` : "loads with the after-close job"} />
        <Gauge value={social.data?.retailGreed ?? null} title="Retail greed" note={social.data ? `Share of bullish posts among the ${social.data.tagged} Stocktwits posts tagged bullish or bearish on today's 20 trending stocks (50 = even; X has no free data)` : "Stocktwits not loaded yet"} />
        {b ? (
          <section className="statbars">
            <Bar left={<>Advancing <b>{Math.round((b.advancing / Math.max(b.advancing + b.declining, 1)) * 100)}%</b> ({b.advancing})</>} right={<>Declining ({b.declining})</>} share={(b.advancing / Math.max(b.advancing + b.declining, 1)) * 100} />
            <Bar left={<>New 52-week highs <b>{b.highs}</b></>} right={<>New lows <b>{b.lows}</b></>} share={b.highs + b.lows ? (b.highs / (b.highs + b.lows)) * 100 : 50} />
            <Bar left={<>Market mood <b>{b.moodLabel}</b></>} right={<>Score <b>{b.mood}</b></>} share={b.mood} color="mood" />
          </section>
        ) : null}
      </div>
      {b && <p className="small muted" style={{ margin: "-4px 0 12px" }}>Breadth across the scout&apos;s {b.stocks} large and mid caps on {fmtDay(b.asOf)}, not the whole market. Mood: {b.parts}.</p>}

      <div className="panels-grid">
        <MoversTable gainers={movers.data?.gainers ?? []} losers={movers.data?.losers ?? []} scope={movers.data?.scope ?? "all US stocks"} />
        <SocialTable rows={social.data?.rows ?? []} />
        <section className="card panel">
          <Head title="Market & rates" note="vs previous close" updatedAt={market.updatedAt} error={market.error} />
          <table><tbody>
            {(market.data ?? []).map((r) => (
              <tr key={r.label}><td>{r.label}</td><td className="num">{r.value}</td>
                <td className={`num ${r.changePct === null ? "" : r.changePct >= 0 ? "pos" : "neg"}`}>{r.changePct === null ? "—" : r.label.includes("Treasury") ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)} pts` : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`}</td></tr>
            ))}
            {!market.data?.length && <tr><td className="muted">Not loaded yet.</td></tr>}
          </tbody></table>
          <p className="small muted">Index futures need a paid feed; the ETFs stand in for them. Yields from the Treasury, VIX from Cboe (delayed).</p>
        </section>

        <section className="card panel">
          <Head title={`Earnings · next 5 days${earnings.data ? ` (${earnings.data.total})` : ""}`} note="largest first" updatedAt={earnings.updatedAt} error={earnings.error} />
          <table><tbody>
            {(earnings.data?.rows ?? []).map((r) => (
              <tr key={r.symbol + r.date}><td><Ticker symbol={r.symbol} /> <span className="small muted">{cap(r.marketCap)}</span></td><td className="small">{fmtDay(r.date)}{r.time ? <span className="muted"> · {r.time}</span> : null}</td><td className="num small">{r.eps ? `EPS est. ${r.eps}` : ""}</td></tr>
            ))}
            {!earnings.data?.rows.length && <tr><td className="muted">Not loaded yet.</td></tr>}
          </tbody></table>
        </section>

        <section className="card panel">
          <Head title="Government contracts · latest" note="USAspending, listed companies" updatedAt={contracts.updatedAt} error={contracts.error} />
          <table><tbody>
            {(contracts.data ?? []).map((r, i) => (
              <tr key={i} title={`${r.recipient}: ${r.description}`}><td><Ticker symbol={r.ticker} /></td><td className="small secondary">{r.agency}</td><td className="num">{money(r.amount)}</td><td className="num small muted">{fmtDay(r.date)}</td></tr>
            ))}
            {!contracts.data?.length && <tr><td className="muted">{contracts.error ? "Unavailable right now." : "No listed companies among the largest recent awards."}</td></tr>}
          </tbody></table>
          <p className="small muted">New obligations by action date; agencies report with a lag of days. Hover a row for the recipient and description.</p>
        </section>

        <section className="card panel">
          <Head title="Buzz score · top 10" note="out of 20" updatedAt={buzz.updatedAt} error={buzz.error} />
          <div className="chips">
            {(buzz.data ?? []).map((r) => <span key={r.symbol} className="chip" title={r.parts}><b>{r.symbol}</b> <span className="muted">{r.score}/20</span></span>)}
            {!buzz.data?.length && <span className="small muted">Builds up as the chatter test records its first days.</span>}
          </div>
          <p className="small muted">Chatter spike against the stock&apos;s own normal (0–8), news against its usual pace (0–6), Stocktwits trending (0–6). Hover a chip for the parts.</p>
        </section>

        <section className="card panel">
          <div className="panel-head"><span>Congress buys · 30 days</span><a className="small" href="/congress">All trades →</a></div>
          <div className="chips">
            {congress.map((a) => <a key={a.symbol} href={`/congress?symbol=${a.symbol}`} className="chip" title={`Bought by ${a.buyers.join(", ")}${a.sellers.length ? `; sold by ${a.sellers.join(", ")}` : ""}`}><b>{a.symbol}</b> <span className="muted">{a.buyers.length} {a.buyers.length === 1 ? "member" : "members"}</span></a>)}
            {!congress.length && <span className="small muted">Loads as House transaction reports are read (hourly).</span>}
          </div>
          <p className="small muted">Members of Congress (House and Senate): reported purchases by filing date, most buyers first. Reports can be up to 45 days after the trade.</p>
        </section>

        <section className="card panel">
          <div className="panel-head"><span>Unusual options positions · 5 days</span><a className="small" href="/filings#options">Details →</a></div>
          <div className="chips">
            {optionFlags.slice(0, 10).map((f) => <a key={f.date + f.contract} href="/filings#options" className="chip" title={`${f.date}: +${(f.oi - f.prevOi).toLocaleString("en-US")} contracts${f.structure ? `; ${f.structure}` : ""}`}><b className={f.type === "put" ? "neg" : "pos"}>{f.symbol}</b> <span className="muted">${f.strike} {f.type}s {f.expiry.slice(2, 7)}{f.premiumUsd ? ` · ${money(f.premiumUsd)}` : ""}</span></a>)}
            {!optionFlags.length && <span className="small muted">None flagged. Option chains are read once each trading day; flags start from the second day.</span>}
          </div>
          <p className="small muted">New out-of-the-money positions many times the stock&apos;s normal, from Cboe open interest. The side (bought or sold) is not visible.</p>
        </section>

        <section className="card panel">
          <div className="panel-head"><span>Trump posts · market-relevant, 3 days</span><span className="small muted">most urgent first</span></div>
          {posts.map((p) => (
            <div key={p.id} className="digest-item">
              <div className="small">
                <b className={p.read!.direction === "up" ? "pos" : p.read!.direction === "down" ? "neg" : ""}>{p.read!.direction === "up" ? "▲ " : p.read!.direction === "down" ? "▼ " : ""}{p.read!.tickers.slice(0, 4).join(", ") || p.read!.sectors.slice(0, 2).join(", ")}</b>{" "}
                {p.read!.summary}
              </div>
              <div className="small muted">{"●".repeat(Math.max(1, Math.min(5, p.read!.urgency)))}{"○".repeat(5 - Math.max(1, Math.min(5, p.read!.urgency)))} · <a href={p.url} target="_blank" rel="noreferrer">{fmtEt(p.at)}</a></div>
            </div>
          ))}
          {!posts.length && <p className="small muted">No market-relevant posts in the last 3 days (read every few minutes from the trumpstruth.org archive of his Truth Social posts).</p>}
        </section>

        <section className="card panel">
          <Head title="Prediction markets · biggest odds moves" note="Polymarket" updatedAt={polymarket.updatedAt} error={polymarket.error} />
          <table><tbody>
            {(polymarket.data ?? []).map((r) => (
              <tr key={r.question}>
                <td className="small">{r.slug ? <a href={`https://polymarket.com/market/${r.slug}`} target="_blank" rel="noreferrer">{r.question}</a> : r.question}{r.endDate ? <span className="muted"> · ends {fmtDay(r.endDate)}</span> : null}</td>
                <td className="num"><b>{r.yes}%</b></td>
                <td className={`num small ${(r.dayChange ?? 0) >= 0 ? "pos" : "neg"}`}>{r.dayChange === null ? "—" : `${r.dayChange >= 0 ? "+" : ""}${r.dayChange} 1d`}</td>
                <td className={`num small ${(r.weekChange ?? 0) >= 0 ? "pos" : "neg"}`}>{r.weekChange === null ? "—" : `${r.weekChange >= 0 ? "+" : ""}${r.weekChange} 7d`}</td>
              </tr>
            ))}
            {!polymarket.data?.length && <tr><td className="muted">Not loaded yet.</td></tr>}
          </tbody></table>
          <p className="small muted">The 100 busiest open markets; changes in percentage points. Market-moving odds (Fed, tariffs, elections, wars) feed the daily discovery scan too.</p>
        </section>
      </div>
    </>
  );
}
