"use client";

import { useState } from "react";
import { chartUrl } from "@/config/links";
import type { MoverRow, SocialRow } from "@/lib/market/social";

const vol = (v: number | null) => (v === null ? "—" : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(v));
const T = ({ s }: { s: string }) => <a className="ticker accent" href={chartUrl(s)} target="_blank" rel="noreferrer">{s}</a>;

function Tabs<K extends string>({ tabs, value, onChange }: { tabs: Array<[K, string]>; value: K; onChange: (k: K) => void }) {
  return <span className="filter-links small">{tabs.map(([k, l]) => <button key={k} className={`chip${k === value ? " active" : ""}`} onClick={() => onChange(k)}>{l}</button>)}</span>;
}

export function MoversTable({ gainers, losers, scope }: { gainers: MoverRow[]; losers: MoverRow[]; scope: string }) {
  const [tab, setTab] = useState<"gainers" | "losers">("gainers");
  const rows = tab === "gainers" ? gainers : losers;
  return (
    <section className="card panel">
      <div className="panel-head"><span>Top {tab}</span><Tabs tabs={[["gainers", "Gainers"], ["losers", "Losers"]]} value={tab} onChange={setTab} /></div>
      <table><tbody>
        {rows.map((r) => (
          <tr key={r.symbol}><td><T s={r.symbol} /></td><td className="num">{r.price.toFixed(2)}</td>
            <td className={`num ${r.changePct >= 0 ? "pos" : "neg"}`}>{r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%</td><td className="num small muted">{vol(r.volume)}</td></tr>
        ))}
        {!rows.length && <tr><td className="muted">Not loaded yet.</td></tr>}
      </tbody></table>
      <p className="small muted">Across {scope}; $1 and up, common stock only. Volume is today&apos;s on the IEX feed.</p>
    </section>
  );
}

type SocialTab = "trending" | "active" | "watched" | "bullish" | "bearish";

export function SocialTable({ rows }: { rows: SocialRow[] }) {
  const [tab, setTab] = useState<SocialTab>("trending");
  const sorted = rows.slice().sort((a, b) =>
    tab === "active" ? (b.perHour ?? 0) - (a.perHour ?? 0)
      : tab === "watched" ? (b.watchers ?? 0) - (a.watchers ?? 0)
        : tab === "bullish" ? (b.bullishPct ?? -1) - (a.bullishPct ?? -1)
          : tab === "bearish" ? (b.bearishPct ?? -1) - (a.bearishPct ?? -1)
            : (a.rank ?? 99) - (b.rank ?? 99)).slice(0, 12);
  return (
    <section className="card panel social-panel">
      <div className="panel-head"><span>Stocktwits</span>
        <Tabs tabs={[["trending", "Trending"], ["active", "Most active"], ["watched", "Most watched"], ["bullish", "Most bullish"], ["bearish", "Most bearish"]]} value={tab} onChange={setTab} />
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Ticker</th><th>Company</th><th className="num">Posts/h</th><th className="num">Bullish</th><th className="num">Bearish</th><th className="num">Watchers</th><th className="num">Rank, 24h</th><th>Also filed</th></tr></thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.symbol}>
              <td className="muted">{i + 1}</td><td><T s={r.symbol} /></td><td className="small secondary">{(r.company ?? "").slice(0, 34)}</td>
              <td className="num">{r.perHour ?? "—"}</td>
              <td className="num pos">{r.bullishPct === null ? "—" : `${r.bullishPct}%`}</td><td className="num neg">{r.bearishPct === null ? "—" : `${r.bearishPct}%`}</td>
              <td className="num">{r.watchers?.toLocaleString("en-US") ?? "—"}</td>
              <td className={`num ${(r.rankChange ?? 0) > 0 ? "pos" : (r.rankChange ?? 0) < 0 ? "neg" : "muted"}`}>{r.rankChange ? `${r.rankChange > 0 ? "▲" : "▼"} ${Math.abs(r.rankChange)}` : "–"}</td>
              <td>{r.insider && <span className="pill it" title="insider open-market purchase in the last 30 days">IT</span>}{r.congress && <span className="pill ct" title="Congress trade reported in the last 30 days">CT</span>}</td>
            </tr>
          ))}
          {!sorted.length && <tr><td colSpan={9} className="muted">Not loaded yet.</td></tr>}
        </tbody>
      </table></div>
      <p className="small muted">The top 20 trending stocks on Stocktwits with their latest 30 posts: posts an hour, and the share tagged bullish or bearish. IT = insider purchase, CT = Congress trade, last 30 days. (X data needs a paid API, so Stocktwits stands in for retail chatter.)</p>
    </section>
  );
}
