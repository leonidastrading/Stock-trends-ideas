import StockChart from "@/components/StockChart";
import SetupNotice from "@/components/SetupNotice";
import { tvSymbol } from "@/config/links";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Any stock's scout chart: earnings lines, the crash-bounce setup, ranges and averages. /chart?symbol=STRO */
export default async function ChartPage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const raw = ((await searchParams).symbol ?? "").trim().toUpperCase().replace(/^\$/, "");
  const symbol = /^[A-Z][A-Z0-9.-]{0,9}$/.test(raw) ? raw : "";
  const [info, cards] = symbol ? await Promise.all([store.symbolInfo([symbol]).then((m) => m.get(symbol) ?? null).catch(() => null), store.cardBriefsSince(365).catch(() => [])]) : [null, []];
  const mine = cards.filter((c) => c.primaryTicker === symbol || c.tickers.includes(symbol));
  return (
    <>
      <h1>Chart{symbol ? `: ${symbol}` : ""}</h1>
      <form className="toolbar" method="get">
        <input name="symbol" defaultValue={symbol} placeholder="Ticker, e.g. STRO" aria-label="Ticker" style={{ width: 160, textTransform: "uppercase" }} />
        <button type="submit">Show chart</button>
        {symbol && info?.name ? <span className="small muted">{info.name}</span> : null}
      </form>
      {mine.length > 0 && (
        <p className="small">Scout cards on {symbol} (last year): {mine.slice(0, 12).map((c, i) => <span key={c.id}>{i ? " · " : ""}<a href={`/cards/${c.id}`}><span className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲" : "▼"}</span> #{c.id}</a> <span className="muted">{c.createdAt.slice(0, 10)}</span></span>)}</p>
      )}
      {symbol ? <StockChart key={symbol} symbol={symbol} tvSymbol={tvSymbol(symbol, info?.exchange)} /> : <p className="small muted">Type a ticker to see its daily chart with earnings dates and the crash-and-bounce short setup.</p>}
    </>
  );
}
