"use client";

import { useEffect, useRef, useState } from "react";
import type { EpsRow, Fundamentals, IncomeRow } from "@/lib/sources/fmp";

/** Money in short form: 23.4B, 812M, -45M. */
export const money = (x: number | null) => {
  if (x === null) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  return a >= 1e12 ? `${s}${(a / 1e12).toFixed(1)}T` : a >= 1e9 ? `${s}${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}${(a / 1e6).toFixed(0)}M` : `${s}${(a / 1e3).toFixed(0)}K`;
};

/** Pure: 3 round ticks from lo to hi (always including 0 when the range crosses it). */
export function ticks(lo: number, hi: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const step0 = span / 3, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= step0) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; out.length < 12; v += step) {
    out.push(Math.round(v * 1e6) / 1e6);
    if (v >= hi - step * 1e-9) break; // the top tick is at or above the highest value, so no mark leaves the chart
  }
  return out;
}

const W = 300, H = 150, L = 44, R = 8, T = 10, B = 22;
const PW = W - L - R, PH = H - T - B;

/** A bar from the baseline with 4px rounded data-end (top for positive, bottom for negative). */
function bar(x: number, w: number, y0: number, y1: number): string {
  const up = y1 < y0, h = Math.abs(y1 - y0), r = Math.min(4, w / 2, h);
  if (h < 0.5) return "";
  return up
    ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`
    : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

function Axis({ vals, y, fmt }: { vals: number[]; y: (v: number) => number; fmt: (v: number) => string }) {
  return <>{vals.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? "viz-base" : "viz-grid"} /><text x={L - 6} y={y(v) + 3} textAnchor="end" className="viz-tick">{fmt(v)}</text></g>)}</>;
}

function IncomeBars({ rows }: { rows: IncomeRow[] }) {
  const vals = rows.flatMap((r) => [r.revenue ?? 0, r.netIncome ?? 0]);
  const tk = ticks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = tk[0], hi = tk[tk.length - 1];
  const y = (v: number) => T + PH - ((v - lo) / (hi - lo || 1)) * PH;
  const gw = PW / rows.length, bw = Math.min(16, (gw - 12) / 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="viz" role="img" aria-label="Revenue and net income by period">
      <Axis vals={tk} y={y} fmt={money} />
      {rows.map((r, i) => {
        const cx = L + gw * i + gw / 2;
        return (
          <g key={r.label}>
            <title>{`${r.label}: revenue ${money(r.revenue)}, net income ${money(r.netIncome)}${r.margin !== null ? `, margin ${r.margin}%` : ""}`}</title>
            <rect x={L + gw * i} y={T} width={gw} height={PH} className="viz-hit" />
            {r.revenue !== null && <path d={bar(cx - bw - 1, bw, y(0), y(r.revenue))} className="viz-s1" />}
            {r.netIncome !== null && <path d={bar(cx + 1, bw, y(0), y(r.netIncome))} className="viz-s2" />}
            <text x={cx} y={H - 6} textAnchor="middle" className="viz-tick">{r.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MarginLine({ rows }: { rows: IncomeRow[] }) {
  const pts = rows.map((r, i) => ({ r, i })).filter((p) => p.r.margin !== null);
  if (pts.length < 2) return <p className="small muted">Not enough periods for a margin line.</p>;
  const ms = pts.map((p) => p.r.margin!);
  const tk = ticks(Math.min(0, ...ms), Math.max(...ms, 0.1));
  const lo = tk[0], hi = tk[tk.length - 1];
  const y = (v: number) => T + PH - ((v - lo) / (hi - lo || 1)) * PH;
  const gw = PW / rows.length, x = (i: number) => L + gw * i + gw / 2;
  const first = pts[0], last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="viz" role="img" aria-label="Net margin by period">
      <Axis vals={tk} y={y} fmt={(v) => `${v}%`} />
      <polyline points={pts.map((p) => `${x(p.i)},${y(p.r.margin!)}`).join(" ")} className="viz-line" />
      {pts.map((p) => (
        <g key={p.r.label}><title>{`${p.r.label}: net margin ${p.r.margin}%`}</title><rect x={x(p.i) - gw / 2} y={T} width={gw} height={PH} className="viz-hit" /><circle cx={x(p.i)} cy={y(p.r.margin!)} r={4} className="viz-dot3" /></g>
      ))}
      {[first, last].map((p, k) => <text key={k} x={x(p.i)} y={y(p.r.margin!) - 9} textAnchor="middle" className="viz-label">{p.r.margin}%</text>)}
      {rows.map((r, i) => <text key={r.label} x={x(i)} y={H - 6} textAnchor="middle" className="viz-tick">{r.label}</text>)}
    </svg>
  );
}

function EpsDots({ rows }: { rows: EpsRow[] }) {
  const vals = rows.flatMap((r) => [r.actual, r.estimate]).filter((v): v is number => v !== null);
  const tk = ticks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = tk[0], hi = tk[tk.length - 1];
  const y = (v: number) => T + PH - ((v - lo) / (hi - lo || 1)) * PH;
  const gw = PW / rows.length, x = (i: number) => L + gw * i + gw / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="viz" role="img" aria-label="Earnings per share, actual and estimate">
      <Axis vals={tk} y={y} fmt={(v) => v.toFixed(2)} />
      {rows.map((r, i) => (
        <g key={r.date}>
          <title>{`${r.label} (${r.date}): ${r.actual !== null ? `actual ${r.actual.toFixed(2)}, ` : "not reported yet, "}estimate ${r.estimate?.toFixed(2) ?? "—"}${r.actual !== null && r.estimate !== null ? ` (${r.actual >= r.estimate ? "beat" : "missed"})` : ""}`}</title>
          <rect x={x(i) - gw / 2} y={T} width={gw} height={PH} className="viz-hit" />
          {r.estimate !== null && <circle cx={x(i)} cy={y(r.estimate)} r={5} className="viz-ring" />}
          {r.actual !== null && <circle cx={x(i)} cy={y(r.actual)} r={6} className="viz-dot1" />}
          <text x={x(i)} y={H - 6} textAnchor="middle" className="viz-tick">{r.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** On a card: the company's income statement (revenue, net income, net margin) and EPS against the estimate, from FMP. */
export default function CardFundamentals({ symbol }: { symbol: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [period, setPeriod] = useState<"annual" | "quarter">("annual");
  const [data, setData] = useState<Fundamentals | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let dead = false;
    setData(null);
    fetch(`/api/fundamentals/${encodeURIComponent(symbol)}?period=${period}`).then((r) => r.json()).then((j) => { if (!dead) setData(j as Fundamentals); }).catch(() => { if (!dead) setData({ symbol, period, income: [], eps: [], error: "could not load" }); });
    return () => { dead = true; };
  }, [visible, symbol, period]);

  const done = data?.eps.filter((r) => r.actual !== null && r.estimate !== null) ?? [];
  const beats = done.filter((r) => r.actual! >= r.estimate!).length;
  return (
    <div ref={box} className="card-fund">
      <div className="card-fund-head">
        <h3>Financials <span className="small muted">{symbol}{data && !data.error ? ` · ${[...new Set([data.income.length ? data.incomeSource : null, data.eps.length ? data.epsSource : null].filter(Boolean))].join(" and ")}` : ""}{data?.currency && data.currency !== "USD" && data.income.length ? ` · amounts in ${data.currency}` : ""}</span></h3>
        <span className="filter-links small">
          <button type="button" className={`chip ${period === "annual" ? "active" : ""}`} onClick={() => setPeriod("annual")}>Annual</button>
          <button type="button" className={`chip ${period === "quarter" ? "active" : ""}`} onClick={() => setPeriod("quarter")}>Quarterly</button>
        </span>
      </div>
      {!data ? <p className="small muted">Loading financials…</p> : data.error && !data.income.length && !data.eps.length ? <p className="small muted">{/fund or ETF/.test(data.error) ? `${symbol} is ${data.error.replace(/^a /, "a ")}.` : `Financials not available: ${data.error}`}</p> : (
        <div className="fund-grid">
          {data.income.length > 0 && <div><div className="small"><b>Revenue and net income</b></div><IncomeBars rows={data.income} /><div className="viz-legend small"><span><i className="sw viz-s1" />Revenue</span><span><i className="sw viz-s2" />Net income</span></div></div>}
          {data.income.length > 0 && <div><div className="small"><b>Net margin</b> <span className="muted">(net income ÷ revenue)</span></div><MarginLine rows={data.income} /></div>}
          {data.eps.length > 0 && <div><div className="small"><b>EPS</b> <span className="muted">{done.length ? `beat the estimate ${beats} of the last ${done.length} quarters` : ""}</span></div><EpsDots rows={data.eps} /><div className="viz-legend small"><span><i className="sw viz-dot1 round" />Actual</span><span><i className="sw viz-ring round" />Estimate</span></div></div>}
        </div>
      )}
    </div>
  );
}
