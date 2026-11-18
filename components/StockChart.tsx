"use client";

import { useEffect, useRef, useState } from "react";
import TvChart from "@/components/TvChart";
import { findCrashBounce, type Bar, type CrashBounce } from "@/lib/market/crash-bounce";

interface BarsReply { symbol: string; bars: Bar[]; raw?: Array<[string, number, number]>; feed?: string; earnings: string[]; next: string | null; nextBasis: string | null; error?: string }
export interface ChartEntry { date: string | null; price: number | null; direction: "long" | "short"; exitBy?: string | null; exitDate?: string | null }

const RANGES = [["1M", 31], ["3M", 92], ["6M", 183], ["YTD", 0], ["1Y", 365], ["2Y", 730], ["All", -1]] as const;
type Range = (typeof RANGES)[number][0];
interface Prefs { range: Range; weekly: boolean; ma: number[]; log: boolean; volume: boolean; setup: boolean }
const DEFAULT: Prefs = { range: "1Y", weekly: false, ma: [], log: false, volume: true, setup: true };
const PREFS_KEY = "scout-chart-prefs";
const MA_COLORS: Record<number, string> = { 20: "#e8a33d", 50: "#3987e5", 200: "#b36bd9" };

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const weekday = (d: string) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** Monday of the date's week. */
const weekOf = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return plusDays(d, -((t.getUTCDay() + 6) % 7)); };

/** Pure: daily bars into weekly ones, each dated by its first trading day. */
function toWeekly(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  let key = "";
  for (const b of bars) {
    const k = weekOf(b[0]);
    const cur = out[out.length - 1];
    if (k !== key || !cur) { out.push([...b] as Bar); key = k; continue; }
    cur[2] = Math.max(cur[2], b[2]); cur[3] = Math.min(cur[3], b[3]); cur[4] = b[4]; cur[5] += b[5];
  }
  return out;
}
const sma = (bars: Bar[], n: number) => bars.map((b, i) => (i + 1 < n ? null : { time: b[0], value: bars.slice(i + 1 - n, i + 1).reduce((a, x) => a + x[4], 0) / n })).filter(Boolean) as Array<{ time: string; value: number }>;

/**
 * The scout's own chart (TradingView's open-source Lightweight Charts, fed with whole-market daily bars), so it can mark
 * what the embedded TradingView chart can't: every earnings release (SEC 8-K item 2.02) as a thin line, the next
 * expected report in its real place on the calendar, the card's paper entry, and the crash-and-bounce short setup.
 * Ranges, daily or weekly bars, moving averages, log scale and volume are on the toolbar; drawing tools are in the
 * TradingView tab.
 */
export default function StockChart({ symbol, tvSymbol, height = 680, entry }: { symbol: string; tvSymbol: string; height?: number; entry?: ChartEntry }) {
  const [tab, setTab] = useState<"scout" | "tv">("scout");
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT);
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [res, setRes] = useState<BarsReply | null>(null);
  const [state, setState] = useState<{ error?: string; legend?: string }>({});
  const [setups, setSetups] = useState<CrashBounce[]>([]);
  // Shorter on phones (set after the first render, so the server and browser render the same thing).
  const [h, setH] = useState(height);
  useEffect(() => { if (window.matchMedia?.("(max-width: 640px)").matches) setH(Math.min(height, 460)); }, [height]);

  // Remembered per viewer (this browser only).
  useEffect(() => { try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null"); if (p) setPrefs({ ...DEFAULT, ...p }); } catch { /* no storage */ } }, []);
  const set = (p: Partial<Prefs>) => setPrefs((old) => { const next = { ...old, ...p }; try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* no storage */ } return next; });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setShow(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!show || res) return;
    fetch(`/api/bars/${encodeURIComponent(symbol)}`).then((r) => r.json() as Promise<BarsReply>).then((r) => {
      if (r.error || !r.bars?.length) { setState({ error: r.error ?? "no price data" }); return; }
      setRes(r);
      setSetups(findCrashBounce(r.bars, r.raw?.length ? new Map(r.raw.map(([d, c, v]) => [d, { c, v }])) : undefined));
    }).catch(() => setState({ error: "could not load the chart" }));
  }, [show, res, symbol]);

  useEffect(() => {
    if (tab !== "scout" || !res || !host.current) return;
    let dead = false;
    let cleanup = () => {};
    (async () => {
      const lib = await import("lightweight-charts");
      if (dead || !host.current) return;
      const text = css("--text-secondary", "#555"), grid = css("--grid", "#eee"), pos = css("--pos", "#067647"), neg = css("--neg", "#b42318"), warn = css("--warn", "#b54708"), accent = css("--accent", "#2a78d6"), muted = css("--text-muted", "#888");
      const bars = prefs.weekly ? toWeekly(res.bars) : res.bars;
      const last = bars[bars.length - 1][0];
      // The bar a date belongs to: its week, the next trading day (a filing made on a weekend), or a future weekday.
      const keyOf = (d: string) => {
        if (prefs.weekly) return bars.find((b) => weekOf(b[0]) === weekOf(d))?.[0] ?? weekOf(d);
        if (d <= last) return bars.find((b) => b[0] >= d)?.[0] ?? d;
        let x = d;
        while (!weekday(x)) x = plusDays(x, 1);
        return x;
      };
      const chart = lib.createChart(host.current, {
        autoSize: true,
        layout: { background: { type: lib.ColorType.Solid, color: "transparent" }, textColor: text, fontSize: 12 },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderVisible: false, mode: prefs.log ? lib.PriceScaleMode.Logarithmic : lib.PriceScaleMode.Normal },
        timeScale: { borderVisible: false },
        crosshair: { mode: lib.CrosshairMode.Normal },
      });

      // Future trading days up to the next report (and a little room), so a future date sits where it belongs.
      const future: string[] = [];
      const until = res.next && res.next > last ? res.next : last;
      for (let d = plusDays(last, 1), pad = 0; d <= until || pad < 8; d = plusDays(d, 1)) {
        if (!weekday(d)) continue;
        if (prefs.weekly && weekOf(d) === weekOf(future[future.length - 1] ?? last)) continue;
        future.push(prefs.weekly ? weekOf(d) : d);
        if (d > until) pad++;
      }
      const candles = chart.addCandlestickSeries({ upColor: pos, downColor: neg, wickUpColor: pos, wickDownColor: neg, borderVisible: false });
      candles.setData([...bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })), ...future.map((time) => ({ time }))]);
      if (prefs.volume) {
        const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
        vol.setData(bars.map(([time, open, , , close, v]) => ({ time, value: v, color: close >= open ? `${pos}55` : `${neg}55` })));
      }
      for (const n of prefs.ma) chart.addLineSeries({ color: MA_COLORS[n], lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, title: `${n}${prefs.weekly ? "w" : "d"}` }).setData(sma(bars, n));

      type Mark = { time: string; position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown" | "square" | "circle"; text: string };
      const marks: Mark[] = [];
      const seg = (a: string, b: string, value: number, color: string, style: number, title = "") => {
        const s = chart.addLineSeries({ color, lineWidth: 1, lineStyle: style, lastValueVisible: !!title, priceLineVisible: false, crosshairMarkerVisible: false, title });
        s.setData(a === b ? [{ time: a, value }] : [{ time: a, value }, { time: b, value }]);
      };
      // The card's paper trade: an arrow at the entry and a dashed line at the entry price.
      if (entry?.date && entry.price) {
        const long = entry.direction === "long";
        marks.push({ time: keyOf(entry.date), position: long ? "belowBar" : "aboveBar", color: accent, shape: long ? "arrowUp" : "arrowDown", text: `${long ? "long" : "short"} entry $${entry.price.toFixed(2)}` });
        if (entry.exitDate) marks.push({ time: keyOf(entry.exitDate), position: long ? "aboveBar" : "belowBar", color: accent, shape: "square", text: "exit" });
        candles.createPriceLine({ price: entry.price, color: accent, lineWidth: 1, lineStyle: lib.LineStyle.Dashed, axisLabelVisible: true, title: "entry" });
      }
      // The crash-and-bounce short setup (daily bars only): peak, first low, the 50% level, and the trade once it starts.
      if (prefs.setup && !prefs.weekly) {
        for (const s of setups) {
          const end = s.until;
          seg(s.peak.date, end, s.peak.price, neg, lib.LineStyle.Dotted, s === setups[setups.length - 1] ? "peak" : "");
          seg(s.firstLow.date, end, s.firstLow.price, muted, lib.LineStyle.Dotted, s === setups[setups.length - 1] ? "first low" : "");
          seg(s.firstLow.date, s.trigger?.date ?? end, s.level, warn, lib.LineStyle.Dashed, s === setups[setups.length - 1] ? "50% level" : "");
          marks.push({ time: s.peak.date, position: "aboveBar", color: neg, shape: "circle", text: `peak $${s.peak.price.toFixed(2)}` });
          marks.push({ time: s.firstLow.date, position: "belowBar", color: muted, shape: "circle", text: `low $${s.firstLow.price.toFixed(2)} (−${s.firstLow.dropPct}%)` });
          if (s.trigger) marks.push({ time: s.trigger.date, position: "aboveBar", color: warn, shape: "square", text: "trigger" });
          if (s.status === "waiting for entry" && s.trigger && s.entryLevel) seg(s.trigger.date, end, s.entryLevel, warn, lib.LineStyle.Solid, "short below");
          if (s.entry && s.stop) {
            const stopAt = s.exit?.date ?? end;
            seg(s.entry.date, stopAt, s.stop, neg, lib.LineStyle.Solid, s.exit ? "" : "stop");
            seg(s.entry.date, stopAt, s.target, pos, lib.LineStyle.Solid, s.exit ? "" : "target");
            marks.push({ time: s.entry.date, position: "aboveBar", color: neg, shape: "arrowDown", text: `short $${s.entry.price.toFixed(2)}` });
            if (s.exit) marks.push({ time: s.exit.date, position: "belowBar", color: s.exit.reason === "target" ? pos : s.exit.reason === "stop" ? neg : accent, shape: "arrowUp", text: `cover (${s.exit.reason}) ${s.returnPct! >= 0 ? "+" : ""}${s.returnPct}%` });
          }
        }
      }
      const known = new Set(bars.map((b) => b[0]));
      candles.setMarkers(marks.filter((m) => known.has(m.time)).sort((a, b) => a.time.localeCompare(b.time)));

      // Range: by position, with room on the right for the next report.
      const startFor = (r: Range): string => {
        const days = RANGES.find((x) => x[0] === r)![1];
        return days === -1 ? bars[0][0] : days === 0 ? `${last.slice(0, 4)}-01-01` : plusDays(last, -days);
      };
      const startIdx = Math.max(0, bars.findIndex((b) => b[0] >= startFor(prefs.range)));
      const nextIdx = res.next && res.next > last ? bars.length + future.indexOf(keyOf(res.next)) : -1;
      // The next report is pulled into view only when it is near (6 weeks); otherwise its label waits off to the right.
      const near = nextIdx >= 0 && nextIdx - (bars.length - 1) <= (prefs.weekly ? 6 : 30);
      chart.timeScale().setVisibleLogicalRange({ from: startIdx, to: Math.max(bars.length - 1 + (prefs.weekly ? 2 : 5), near ? nextIdx + 3 : 0) });

      // Earnings: thin, faint lines drawn over the chart (the next one dashed), kept in place as it scrolls and resizes.
      const past = res.earnings.filter((d) => d >= res.bars[0][0]);
      const lines = [...past.map((d) => ({ d, next: false })), ...(res.next && res.next > last ? [{ d: res.next, next: true }] : [])];
      const draw = () => {
        const o = overlay.current;
        if (!o) return;
        o.innerHTML = "";
        for (const l of lines) {
          const x = chart.timeScale().timeToCoordinate(keyOf(l.d));
          if (x === null) continue;
          const el = document.createElement("div");
          el.className = `earn-line${l.next ? " next" : ""}`;
          el.style.left = `${Math.round(x)}px`;
          el.title = l.next ? `Next earnings, about ${fmtDay(l.d)} (estimated from past reports)` : `Earnings released ${fmtDay(l.d)}`;
          el.innerHTML = `<span>${l.next ? `next E ~${fmtDay(l.d).replace(/, \d{4}$/, "")}` : "E"}</span>`;
          o.appendChild(el);
        }
      };
      let raf = 0;
      const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
      chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
      const ro = new ResizeObserver(redraw);
      ro.observe(host.current);
      redraw();

      const byDay = new Map(bars.map((b) => [b[0], b]));
      const earnWeeks = new Set(past.map(keyOf));
      const legendFor = (d: string | null) => {
        const b = d ? byDay.get(d) : bars[bars.length - 1];
        if (!b) return d && res.next && keyOf(res.next) === d ? `${fmtDay(res.next)}: next earnings (estimated)` : "";
        const prev = bars[bars.indexOf(b) - 1];
        const chg = prev ? ((b[4] / prev[4] - 1) * 100).toFixed(1) : null;
        return `${prefs.weekly ? "Week of " : ""}${fmtDay(b[0])}  O ${b[1].toFixed(2)}  H ${b[2].toFixed(2)}  L ${b[3].toFixed(2)}  C ${b[4].toFixed(2)}${chg ? ` (${Number(chg) >= 0 ? "+" : ""}${chg}%)` : ""}${earnWeeks.has(b[0]) ? "  · earnings" : ""}`;
      };
      setState({ legend: legendFor(null) });
      const dayOf = (t: unknown): string | null => {
        if (typeof t === "string") return t;
        const v = t as { year?: number; month?: number; day?: number } | null;
        return v?.year && v.month && v.day ? `${v.year}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}` : null;
      };
      chart.subscribeCrosshairMove((p) => setState((s) => ({ ...s, legend: legendFor(dayOf(p.time)) })));
      cleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); chart.remove(); if (overlay.current) overlay.current.innerHTML = ""; };
    })().catch((err) => !dead && setState({ error: String(err).slice(0, 120) }));
    return () => { dead = true; cleanup(); };
  }, [tab, res, setups, prefs, entry?.date, entry?.price, entry?.direction, entry?.exitDate]);

  const latest = setups[setups.length - 1];
  const toggleMa = (n: number) => set({ ma: prefs.ma.includes(n) ? prefs.ma.filter((x) => x !== n) : [...prefs.ma, n].sort((a, b) => a - b) });
  return (
    <div ref={box}>
      <div className="chart-tabs small">
        <button type="button" className={tab === "scout" ? "active" : ""} onClick={() => setTab("scout")}>Scout chart</button>
        <button type="button" className={tab === "tv" ? "active" : ""} onClick={() => setTab("tv")}>TradingView</button>
        {tab === "scout" && <>
          <span className="chart-sep" />
          {RANGES.map(([r]) => <button key={r} type="button" className={prefs.range === r ? "active" : ""} onClick={() => set({ range: r })}>{r}</button>)}
          <span className="chart-sep" />
          <button type="button" className={!prefs.weekly ? "active" : ""} onClick={() => set({ weekly: false })}>Daily</button>
          <button type="button" className={prefs.weekly ? "active" : ""} onClick={() => set({ weekly: true })}>Weekly</button>
          <span className="chart-sep" />
          {[20, 50, 200].map((n) => <button key={n} type="button" className={prefs.ma.includes(n) ? "active" : ""} onClick={() => toggleMa(n)} title={`${n}-${prefs.weekly ? "week" : "day"} moving average`}><span className="ma-dot" style={{ background: MA_COLORS[n] }} />MA {n}</button>)}
          <button type="button" className={prefs.log ? "active" : ""} onClick={() => set({ log: !prefs.log })} title="Logarithmic price scale">Log</button>
          <button type="button" className={prefs.volume ? "active" : ""} onClick={() => set({ volume: !prefs.volume })}>Volume</button>
          <button type="button" className={prefs.setup ? "active" : ""} onClick={() => set({ setup: !prefs.setup })} title="Run-up, crash, bounce to the 50% level, short the break (daily bars)">Crash-bounce{setups.length ? ` (${setups.length})` : ""}</button>
        </>}
      </div>
      {tab === "tv" ? <TvChart symbol={symbol} tvSymbol={tvSymbol} height={height} /> : (
        <>
          <div className="tv-chart scout-chart" style={{ height: h }}>
            <div className="chart-legend small">{state.error ? <span className="warn">Chart unavailable: {state.error}</span> : state.legend ?? `Chart of ${symbol} loads as you scroll…`}</div>
            <div ref={host} className="chart-host" aria-label={`${symbol} chart with earnings dates`} />
            <div ref={overlay} className="chart-overlay" />
          </div>
          <div className="small muted chart-foot">
            <span className="key-earn" /> earnings (SEC 8-K)
            {res?.next ? <><span className="key-next" /> next report about {fmtDay(res.next)} (estimated)</> : null}
            {entry?.date ? <><span className="key-entry" /> paper entry</> : null}
            {res?.feed === "iex" ? <span className="warn"> · prices from IEX only (whole-market data unavailable)</span> : null}
          </div>
          {prefs.setup && setups.length > 0 && (
            <div className="small setup-list">
              {setups.slice().reverse().map((s, i) => (
                <div key={s.peak.date} className={i === 0 ? "" : "muted"}>
                  <b>{s === latest ? "Crash-bounce setup" : "Earlier setup"}:</b> peak ${s.peak.price.toFixed(2)} on {fmtDay(s.peak.date)} ({s.peak.runUp}× its 1-year low) → fell {s.firstLow.dropPct}% to ${s.firstLow.price.toFixed(2)} ({fmtDay(s.firstLow.date)}) → 50% level ${s.level.toFixed(2)}
                  {s.trigger ? <>, reached {fmtDay(s.trigger.date)}</> : null}
                  {s.entry ? <> → short ${s.entry.price.toFixed(2)} on {fmtDay(s.entry.date)}, stop ${s.stop?.toFixed(2)}, target ${s.target.toFixed(2)}</> : null}
                  {". "}<span className={s.status === "closed" ? (s.returnPct! >= 0 ? "pos" : "neg") : s.status === "cancelled" ? "muted" : "warn"}>{s.note}{s.returnPct !== null ? ` Result ${s.returnPct >= 0 ? "+" : ""}${s.returnPct}% on the short${s.status === "short open" ? " so far" : ""}.` : ""}</span>
                  {!s.filters.ok && <span className="warn"> Fails the filters: {s.filters.why.join("; ")}.</span>}
                </div>
              ))}
              <div className="muted">Real stocks and ADRs only (no leveraged ETFs or SPACs): check that yourself. Prices are split-adjusted; the $10 test uses the actual traded price.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
