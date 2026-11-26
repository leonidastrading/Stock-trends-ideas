import CardChips from "@/components/CardChips";
import ResearchButton from "@/components/ResearchButton";
import SetupNotice from "@/components/SetupNotice";
import StockChart from "@/components/StockChart";
import Ticker from "@/components/Ticker";
import { tvSymbol } from "@/config/links";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { listedWhere, notStock, ST_SLOTS, stSnapshots, tvForNonStock, type StSnapshot } from "@/lib/scout/st-trending";
import * as store from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const slotLabel = (s: string) => ST_SLOTS.find((x) => x.key === s)?.label ?? s;
const pct = (a: number | null, b: number | null) => (a && b ? (b / a - 1) * 100 : null);
const fmt = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`);
const k = (n: number | null) => (n === null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

/** Stocktwits: the trending ten at 9 AM and 3 PM ET, why each is trending, and how they did after. */
export default async function StocktwitsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const snaps = await stSnapshots(40).catch(() => [] as StSnapshot[]);
  const want = Number((await searchParams).id);
  const snap = snaps.find((s) => s.id === want) ?? snaps[0];
  const syms = [...new Set(snaps.flatMap((s) => s.items.map((i) => i.symbol)))];
  const data = marketDataFromEnv();
  const now = (syms.length && data?.getSnapshots ? await data.getSnapshots(syms).catch(() => ({})) : {}) as Record<string, { price: number }>;
  const briefs = await store.cardBriefsSince(60).catch(() => [] as store.CardBrief[]);
  const cardsOn = (s: string) => briefs.filter((c) => c.primaryTicker === s || c.tickers.includes(s));
  const avgSince = (s: StSnapshot) => { const xs = s.items.map((i) => pct(i.price, now[i.symbol]?.price ?? null)).filter((x): x is number => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };

  if (!snap) return (<><h1>Stocktwits</h1><p className="small muted">The trending ten is kept at 9 AM and 3 PM New York time every day; the first snapshot arrives at the next of those times.</p></>);
  return (
    <>
      <h1>Stocktwits</h1>
      <p className="small muted">TRENDING TEN · {longDay(snap.date).toUpperCase()} · {slotLabel(snap.slot)} ET</p>
      <p className="small secondary">The top of <a href="https://stocktwits.com/sentiment" target="_blank" rel="noreferrer">Stocktwits&apos; trending list</a> as of {fmtEtAgo(snap.takenAt)}, with why each one is trending (Stocktwits&apos; own summary), its latest headlines and a live chart. A new list is kept at 9 AM and 3 PM New York time every day; the move since is from the price at the snapshot.</p>

      {snap.market.length > 0 && (
        <section className="card">
          <h2>The market {snap.slot === "am" ? "this morning" : "this afternoon"}</h2>
          <ol className="small">{snap.market.map((m) => <li key={m.url}><a href={m.url} target="_blank" rel="noreferrer">{m.headline}</a> <span className="muted">· {m.source} · {fmtEtAgo(m.at)}</span></li>)}</ol>
        </section>
      )}

      <div className="toolbar">{snap.items.map((i) => <a key={i.symbol} className="chip" href={`#st-${i.symbol}`}><b>{i.rank}</b> {i.symbol}</a>)}</div>

      {snap.items.map((i) => {
        const since = pct(i.price, now[i.symbol]?.price ?? null);
        const cards = cardsOn(i.symbol);
        return (
          <section key={i.symbol} id={`st-${i.symbol}`} className="card">
            <div className="pr-head">
              <span className="theme-rank">#{i.rank}</span>
              <a className="theme-ticker" href={`https://stocktwits.com/symbol/${encodeURIComponent(i.symbol)}`} target="_blank" rel="noreferrer">{i.symbol}</a>
              <span>{i.name}</span>
              {since !== null && <span className={`tag ${since >= 0 ? "ok" : "error"}`} title={`From $${i.price?.toFixed(2)} at the snapshot`}>{fmt(since)} since</span>}
            </div>
            <div className="small muted" style={{ margin: "4px 0" }}>
              {i.exchange ? <>Exchange <b>{i.exchange}</b> · </> : null}{i.sector && i.sector !== "0" ? <>Sector <b>{i.sector}</b> · </> : null}Watchers <b>{k(i.watchers)}</b>{i.price ? <> · ${i.price.toFixed(2)} at the snapshot</> : null}
            </div>
            <div style={{ margin: "6px 0" }}><b>Why it&apos;s trending:</b> {i.summary ?? <span className="muted">no summary from Stocktwits</span>}</div>
            {i.headlines.length > 0 && <ul className="small">{i.headlines.map((h) => <li key={h.url}><a href={h.url} target="_blank" rel="noreferrer">{h.headline}</a> <span className="muted">· {h.source} · {fmtEtAgo(h.at)}</span></li>)}</ul>}
            {notStock(i) ? <div className="small muted" style={{ margin: "6px 0" }}>Not a US-listed stock ({listedWhere(i)}), so no scout card or scout chart{tvForNonStock(i) ? "" : " and no chart for this listing"}. A US fund may track it if you want a trade (gold: GLD; Australian dollar: FXA; euro: FXE; yen: FXY; bitcoin: IBIT).</div> : <div className="small" style={{ margin: "6px 0" }}>{cards.length ? <>Scout cards: <CardChips cards={cards} max={6} /> </> : null}<ResearchButton symbol={i.symbol} term={`stocktwits: ${i.symbol} trending ${snap.date}`.slice(0, 80)} observation={`${i.symbol} (${i.name ?? ""}) is #${i.rank} on Stocktwits' trending list (${snap.date}, ${slotLabel(snap.slot)} ET). Stocktwits says it is trending because: ${i.summary ?? "no summary"}. Recent headlines: ${i.headlines.map((h) => h.headline).join(" | ")}. Research whether there is a trade: what is real versus chatter, what is already priced, and whether the attention is early or late.`} kind="event" from={{ label: "Stocktwits", url: "/stocktwits" }} /></div>}
            {(!notStock(i) || tvForNonStock(i)) && <StockChart symbol={i.symbol} tvSymbol={notStock(i) ? tvForNonStock(i)! : tvSymbol(i.symbol, i.exchange)} height={420} tvOnly={notStock(i)} />}
          </section>
        );
      })}

      <section className="card">
        <h2>Earlier lists</h2>
        <p className="small muted">Each kept list and how its ten have moved since (average, from the price at the snapshot).</p>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Tickers</th><th className="num">Since</th></tr></thead>
          <tbody>{snaps.map((s) => { const a = avgSince(s); return (
            <tr key={s.id} className={s.id === snap.id ? "active" : undefined}><td className="small" style={{ whiteSpace: "nowrap" }}><a href={`/stocktwits?id=${s.id}`}>{short(s.date)} · {slotLabel(s.slot)}</a></td><td className="small">{s.items.map((i, n) => <span key={i.symbol}>{n ? " · " : ""}<Ticker symbol={i.symbol} /> <span className={pct(i.price, now[i.symbol]?.price ?? null) === null ? "muted" : (pct(i.price, now[i.symbol]?.price ?? null)! >= 0 ? "pos" : "neg")}>{fmt(pct(i.price, now[i.symbol]?.price ?? null))}</span></span>)}</td><td className={`num ${a === null ? "" : a >= 0 ? "pos" : "neg"}`}>{fmt(a)}</td></tr>
          ); })}</tbody></table></div>
      </section>
      <p className="small muted">Trending list and summaries: Stocktwits. Headlines: Alpaca (Benzinga) and Google News. Not investment advice.</p>
    </>
  );
}
