"use client";

import { useEffect, useRef, useState } from "react";

const SCRIPT = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

/**
 * A daily TradingView chart (their free embedded Advanced Chart widget), loaded only when the card scrolls near the
 * screen, so a page of cards does not load ten charts at once. Follows the dashboard's light or dark look.
 */
export default function TvChart({ symbol, tvSymbol, height = 340 }: { symbol: string; tvSymbol: string; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  // Load when near the screen (a collapsed card's chart is hidden, so it waits until the card is opened).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setShow(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); } }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // TradingView's embed: a container with a script whose text is the widget's settings.
  useEffect(() => {
    const h = host.current;
    if (!show || !h) return;
    const forced = document.documentElement.dataset.theme;
    const dark = forced ? forced === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    h.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.type = "text/javascript";
    s.text = JSON.stringify({
      symbol: tvSymbol, interval: "D", range: "6M", timezone: "America/New_York", theme: dark ? "dark" : "light", style: "1", locale: "en",
      autosize: true, allow_symbol_change: false, hide_side_toolbar: true, hide_volume: false, save_image: false, calendar: false, details: false, hotlist: false,
      withdateranges: true, support_host: "https://www.tradingview.com",
    });
    h.appendChild(s);
    return () => { h.innerHTML = ""; };
  }, [show, tvSymbol]);

  return (
    <div className="tv-chart" ref={box} style={{ height }}>
      {show ? <div className="tradingview-widget-container" ref={host} style={{ height: "100%", width: "100%" }} aria-label={`${symbol} daily chart (TradingView)`} />
        : <div className="tv-chart-placeholder small muted">Daily chart of {symbol} loads as you scroll…</div>}
    </div>
  );
}
