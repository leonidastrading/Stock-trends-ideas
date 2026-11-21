"use client";

import { useEffect, useState } from "react";
import StockChart, { type ChartMark } from "@/components/StockChart";

interface PersonTrade { date: string; side: "buy" | "sell"; shares: number; price: number; value: number; ownedAfter: number | null; plan10b5: boolean; owner: string; ownerCik: string; role: string | null; url: string }
interface Reply { symbol: string; owners: Array<{ cik: string; name: string; role: string | null }>; trades: PersonTrade[]; error?: string }

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
const sh = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString("en-US"));
/** "SMITH JOHN A" (the SEC's order: last name first) → "Smith", short enough for a chart label. */
const short = (name: string) => { const w = name.split(/[ ,]+/)[0] ?? name; return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); };

/** A line chart of the stock with every open-market buy (and sale) by its insiders marked with shares and price; pick one person or all. */
export default function InsiderChart({ symbol, tvSymbol, owner }: { symbol: string; tvSymbol: string; owner?: string | null }) {
  const [res, setRes] = useState<Reply | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [who, setWho] = useState<string>(owner ?? "all");
  const [sales, setSales] = useState(true);
  useEffect(() => {
    fetch(`/api/insiders/${encodeURIComponent(symbol)}`).then((r) => r.json() as Promise<Reply>).then((r) => (r.error ? setErr(r.error) : setRes(r))).catch(() => setErr("could not load the insider trades"));
  }, [symbol]);
  const trades = (res?.trades ?? []).filter((t) => (who === "all" || t.ownerCik === who) && (sales || t.side === "buy"));
  const marks: ChartMark[] = trades.map((t) => ({ date: t.date, side: t.side, text: `${who === "all" ? `${short(t.owner)} ` : ""}${t.side === "buy" ? "+" : "−"}${sh(t.shares)} @ $${t.price.toFixed(2)}` }));
  const bought = trades.filter((t) => t.side === "buy");
  return (
    <div className="insider-chart">
      {err && <p className="small neg">{err}</p>}
      {!res && !err && <p className="small muted">Reading every Form 4 these insiders filed at {symbol} (two years, from the SEC)…</p>}
      {res && (
        <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <button type="button" className={`chip${who === "all" ? " active" : ""}`} onClick={() => setWho("all")}>All insiders</button>
          {res.owners.map((o) => <button type="button" key={o.cik} className={`chip${who === o.cik ? " active" : ""}`} onClick={() => setWho(o.cik)} title={o.role ?? ""}>{o.name}</button>)}
          <label className="muted" style={{ marginLeft: 8 }}><input type="checkbox" checked={sales} onChange={(e) => setSales(e.target.checked)} /> show sales</label>
          {bought.length > 0 && <span className="muted">· {bought.length} buy{bought.length === 1 ? "" : "s"}, {sh(bought.reduce((a, t) => a + t.shares, 0))} shares, {usd(bought.reduce((a, t) => a + t.value, 0))}</span>}
        </div>
      )}
      <StockChart symbol={symbol} tvSymbol={tvSymbol} height={460} line marks={marks} />
      {res && trades.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}><table className="small">
          <thead><tr><th>Date</th><th>Insider</th><th>Trade</th><th className="num">Shares</th><th className="num">Price</th><th className="num">Value</th><th className="num">Owned after</th><th>Form 4</th></tr></thead>
          <tbody>{trades.map((t, i) => (
            <tr key={`${t.ownerCik}-${t.date}-${t.side}-${i}`}>
              <td>{t.date}</td><td>{t.owner}{t.role ? <span className="muted"> ({t.role})</span> : null}</td>
              <td className={t.side === "buy" ? "pos" : "neg"}>{t.side === "buy" ? "▲ buy" : "▼ sale"}{t.plan10b5 ? <span className="muted"> (10b5-1 plan)</span> : null}</td>
              <td className="num">{t.shares.toLocaleString("en-US")}</td><td className="num">${t.price.toFixed(2)}</td><td className="num">{usd(t.value)}</td>
              <td className="num">{t.ownedAfter === null ? "—" : t.ownedAfter.toLocaleString("en-US")}</td>
              <td><a href={t.url} target="_blank" rel="noreferrer">SEC</a></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {res && trades.length === 0 && <p className="small muted">No open-market trades found for {who === "all" ? "these insiders" : "this insider"} in the last two years.</p>}
    </div>
  );
}
