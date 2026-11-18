"use client";

import { useEffect, useRef, useState } from "react";
import TvChart from "@/components/TvChart";

interface BarsReply { symbol: string; bars: Array<[string, number, number, number, number, number]>; earnings: string[]; next: string | null; nextBasis: string | null; error?: string }
export interface ChartEntry { date: string | null; price: number | null; direction: "long" | "short"; exitBy?: string | null; exitDate?: string | null }

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The scout's own daily chart (TradingView's open-source Lightweight Charts, fed with our bars), so it can mark what
 * the embedded TradingView chart can't: every earnings release as a vertical line (from the SEC's 8-K item 2.02
 * dates), the next expected report, and the card's paper entry. The full TradingView chart is one tab away.
 */
export default function StockChart({ symbol, tvSymbol, height = 680, entry }: { symbol: string; tvSymbol: string; height?: number; entry?: ChartEntry }) {
  const [tab, setTab] = useState<"scout" | "tv">("scout");
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [state, setState] = useState<{ error?: string; legend?: string; earnings?: number }>({});
  const h = typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches ? Math.min(height, 460) : height;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setShow(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!show || tab !== "scout" || !host.current) return;
    let dead = false;
    let cleanup = () => {};
    (async () => {
      const [lib, res] = await Promise.all([import("lightweight-charts"), fetch(`/api/bars/${encodeURIComponent(symbol)}`).then((r) => r.json() as Promise<BarsReply>).catch(() => null)]);
      if (dead || !host.current) return;
      if (!res || res.error || !res.bars?.length) { setState({ error: res?.error ?? "could not load the chart" }); return; }
      const text = css("--text-secondary", "#555"), grid = css("--grid", "#eee"), pos = css("--pos", "#067647"), neg = css("--neg", "#b42318"), warn = css("--warn", "#b54708"), accent = css("--accent", "#2a78d6");
      const chart = lib.createChart(host.current, {
        autoSize: true,
        layout: { background: { type: lib.ColorType.Solid, color: "transparent" }, textColor: text, fontSize: 12 },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, rightOffset: 4 },
        crosshair: { mode: lib.CrosshairMode.Normal },
      });
      // Earnings: a full-height band on its own hidden scale (past reports amber, the next expected one dashed blue-ish).
      const ev = chart.addHistogramSeries({ priceScaleId: "ev", lastValueVisible: false, priceLineVisible: false, base: 0 });
      chart.priceScale("ev").applyOptions({ scaleMargins: { top: 0.07, bottom: 0 }, visible: false });
      const first = res.bars[0][0];
      const past = res.earnings.filter((d) => d >= first);
      const evData = [...past.map((d) => ({ time: d, value: 1, color: `${warn}55` })), ...(res.next && !past.includes(res.next) ? [{ time: res.next, value: 1, color: `${accent}40` }] : [])].sort((a, b) => a.time.localeCompare(b.time));
      ev.setData(evData);
      ev.setMarkers(evData.map((p) => ({ time: p.time, position: "aboveBar" as const, color: p.time === res.next ? accent : warn, shape: "circle" as const, text: p.time === res.next ? "next E" : "E" })));

      const candles = chart.addCandlestickSeries({ upColor: pos, downColor: neg, wickUpColor: pos, wickDownColor: neg, borderVisible: false });
      candles.setData(res.bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
      const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(res.bars.map(([time, open, , , close, v]) => ({ time, value: v, color: close >= open ? `${pos}55` : `${neg}55` })));

      // The card's paper trade: an arrow at the entry and a dashed line at the entry price.
      if (entry?.date && entry.price) {
        const long = entry.direction === "long";
        type Mark = { time: string; position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown" | "square"; text: string };
        const marks: Mark[] = [{ time: entry.date, position: long ? "belowBar" : "aboveBar", color: accent, shape: long ? "arrowUp" : "arrowDown", text: `${long ? "long" : "short"} entry $${entry.price.toFixed(2)}` }];
        if (entry.exitDate) marks.push({ time: entry.exitDate, position: long ? "aboveBar" : "belowBar", color: accent, shape: "square", text: "exit" });
        candles.setMarkers(marks.filter((m) => res.bars.some((b) => b[0] === m.time)).sort((a, b) => a.time.localeCompare(b.time)));
        candles.createPriceLine({ price: entry.price, color: accent, lineWidth: 1, lineStyle: lib.LineStyle.Dashed, axisLabelVisible: true, title: "entry" });
      }

      // One year by default; scroll or pinch for the rest.
      const last = res.bars[res.bars.length - 1][0];
      const from = new Date(Date.parse(`${last}T12:00:00Z`) - 365 * 86400_000).toISOString().slice(0, 10);
      // By position, with room on the right so the next report and the latest labels aren't cut off.
      const times = [...new Set([...res.bars.map((b) => b[0]), ...evData.map((e) => e.time)])].sort();
      const start = times.findIndex((t) => t >= from);
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, start), to: times.length - 1 + 12 });

      const byDay = new Map(res.bars.map((b) => [b[0], b]));
      const earnSet = new Set(past);
      const legendFor = (d: string | null) => {
        const b = d ? byDay.get(d) : res.bars[res.bars.length - 1];
        if (!b) return d === res.next ? `${fmtDay(d!)}: next earnings ${res.nextBasis === "estimated" ? "(estimated)" : "(scheduled)"}` : "";
        const chg = b[1] ? ((b[4] / b[1] - 1) * 100).toFixed(1) : null;
        return `${fmtDay(b[0])}  O ${b[1].toFixed(2)}  H ${b[2].toFixed(2)}  L ${b[3].toFixed(2)}  C ${b[4].toFixed(2)}${chg ? ` (${Number(chg) >= 0 ? "+" : ""}${chg}% on the day)` : ""}${earnSet.has(b[0]) ? "  · earnings released" : ""}`;
      };
      setState({ legend: legendFor(null), earnings: past.length });
      // Lightweight Charts hands back the time as given ("YYYY-MM-DD") or as a business-day object.
      const dayOf = (t: unknown): string | null => {
        if (typeof t === "string") return t;
        const b = t as { year?: number; month?: number; day?: number } | null;
        return b?.year && b.month && b.day ? `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}` : null;
      };
      chart.subscribeCrosshairMove((p) => setState((s) => ({ ...s, legend: legendFor(dayOf(p.time)) })));
      cleanup = () => chart.remove();
    })().catch((err) => !dead && setState({ error: String(err).slice(0, 120) }));
    return () => { dead = true; cleanup(); };
  }, [show, tab, symbol, entry?.date, entry?.price, entry?.direction, entry?.exitDate]);

  return (
    <div ref={box}>
      <div className="chart-tabs small">
        <button type="button" className={tab === "scout" ? "active" : ""} onClick={() => setTab("scout")}>Chart with earnings</button>
        <button type="button" className={tab === "tv" ? "active" : ""} onClick={() => setTab("tv")}>TradingView</button>
        {tab === "scout" && <span className="muted chart-key"><span className="key-earn" /> earnings{state.earnings !== undefined ? ` (${state.earnings})` : ""} <span className="key-next" /> next report{entry?.date ? <> <span className="key-entry" /> paper entry</> : null}</span>}
      </div>
      {tab === "tv" ? <TvChart symbol={symbol} tvSymbol={tvSymbol} height={height} /> : (
        <div className="tv-chart scout-chart" style={{ height: h }}>
          <div className="chart-legend small">{state.error ? <span className="warn">Chart unavailable: {state.error}</span> : state.legend ?? `Daily chart of ${symbol} loads as you scroll…`}</div>
          <div ref={host} style={{ position: "absolute", inset: "26px 0 0 0" }} aria-label={`${symbol} daily chart with earnings dates`} />
        </div>
      )}
    </div>
  );
}
