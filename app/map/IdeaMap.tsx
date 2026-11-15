"use client";

import { useMemo, useState } from "react";
import { chartUrl } from "@/config/links";
import type { MapNode } from "@/lib/scout/idea-map";
import { MAP_SOURCES, type MapSourceKey } from "@/lib/scout/map-sources";
import { useStoredState } from "@/components/useStoredState";

const W = 1200, H = 760, CX = W / 2, CY = H / 2;

/** Deterministic 0..1 from a string, so the layout is the same on every load. */
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 10000) / 10000; };

/** Sources on an ellipse; each stock starts between its sources and the centre, then nodes are pushed apart. */
function layout(nodes: MapNode[]) {
  const src = new Map(MAP_SOURCES.map((s, i) => {
    const a = (i / MAP_SOURCES.length) * Math.PI * 2 - Math.PI / 2;
    return [s.key, { ...s, x: CX + Math.cos(a) * (W / 2 - 70), y: CY + Math.sin(a) * (H / 2 - 50) }];
  }));
  // Cards are sized by confidence (30 or less = small, 80 and up = largest); other stocks by how many sources flag them.
  const r = (n: MapNode) => (n.confidence !== null ? 10 + Math.max(0, Math.min(1, (n.confidence - 30) / 50)) * 20 : 8 + Math.min(4, n.links.length) * 3) + Math.min(3, n.links.length - 1) * 2;
  const pts = nodes.map((n) => {
    const ss = n.links.map((l) => src.get(l.source)!);
    const ax = ss.reduce((a, s) => a + s.x, 0) / ss.length, ay = ss.reduce((a, s) => a + s.y, 0) / ss.length;
    const pull = n.links.length > 1 ? 0.35 : 0.62; // multi-source stocks sit near the middle
    const tx = CX + (ax - CX) * pull, ty = CY + (ay - CY) * pull;
    return { n, r: r(n), tx, ty, x: tx + (hash(n.symbol) - 0.5) * 60, y: ty + (hash(`${n.symbol}y`) - 0.5) * 60 };
  });
  for (let it = 0; it < 140; it++) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      p.x += (p.tx - p.x) * 0.02; p.y += (p.ty - p.y) * 0.02;
      for (let j = i + 1; j < pts.length; j++) {
        const q = pts[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 0.01, min = p.r + q.r + 3;
        if (d < min) { const push = (min - d) / 2, ux = dx / d, uy = dy / d; p.x -= ux * push; p.y -= uy * push; q.x += ux * push; q.y += uy * push; }
      }
      p.x = Math.max(p.r + 90, Math.min(W - p.r - 90, p.x)); p.y = Math.max(p.r + 40, Math.min(H - p.r - 40, p.y));
    }
  }
  return { src, pts };
}

type Show = "all" | "card" | "promoted";

export default function IdeaMap({ nodes: all }: { nodes: MapNode[] }) {
  const [show, setShow] = useStoredState<Show>("map-show", "all");
  // The map is laid out again around the stocks shown, so a filtered view is not crowded by hidden ones.
  const nodes = useMemo(() => all.filter((n) => show === "all" || (show === "card" ? !!n.cardId : n.status === "promoted")), [all, show]);
  const { src, pts } = useMemo(() => layout(nodes), [nodes]);
  const [hover, setHover] = useState<string | null>(null);
  const [only, setOnly] = useStoredState<MapSourceKey | null>("map-only", null);
  const shows: Array<[Show, string, number]> = [["all", "All stocks", all.length], ["card", "With a card", all.filter((n) => n.cardId).length], ["promoted", "Promoted cards only", all.filter((n) => n.status === "promoted").length]];
  const counts = new Map<string, number>();
  for (const n of nodes) for (const l of n.links) counts.set(l.source, (counts.get(l.source) ?? 0) + 1);
  const lit = (p: { n: MapNode }) => (hover ? p.n.symbol === hover : only ? p.n.links.some((l) => l.source === only) : true);
  const hovered = pts.find((p) => p.n.symbol === hover);

  return (
    <div className="idea-map card">
      <div className="toolbar" style={{ margin: "0 4px 6px" }}>
        <span className="filter-links small">
          {shows.map(([k, label, n]) => <button key={k} className={`chip${show === k ? " active" : ""}`} onClick={() => { setShow(k); setHover(null); }}>{label} <span className="muted">{n}</span></button>)}
        </span>
      </div>
      {nodes.length === 0 && <p className="small muted" style={{ margin: "0 4px 6px" }}>{show === "promoted" ? "No promoted cards in the last 30 days." : "No stocks with a card in the last 30 days."}</p>}
      <div className="small muted map-status">
        {only ? <>Showing <b style={{ color: src.get(only)!.color }}>{src.get(only)!.label}</b>: {counts.get(only) ?? 0} stocks · <button className="chip" onClick={() => setOnly(null)}>show all</button></>
          : <>{nodes.length} stocks · {nodes.filter((n) => n.links.length > 1).length} flagged by more than one source · hover a stock for why, click a source to isolate it</>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="map-svg" onMouseLeave={() => setHover(null)}>
        <defs>
          <radialGradient id="map-bg" cx="50%" cy="50%" r="65%"><stop offset="0%" stopColor="var(--surface-2)" /><stop offset="100%" stopColor="var(--surface-0)" /></radialGradient>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#map-bg)" rx="10" />
        {pts.flatMap((p) => p.n.links.map((l) => {
          const s = src.get(l.source)!;
          const on = lit(p) && (!only || l.source === only || !!hover);
          return <line key={`${p.n.symbol}-${l.source}`} x1={p.x} y1={p.y} x2={s.x} y2={s.y} stroke={s.color} strokeWidth={on && (hover || only) ? 1.6 : 0.8} opacity={on ? (hover || only ? 0.85 : 0.22) : 0.04} />;
        }))}
        {[...src.values()].map((s) => (
          <g key={s.key} className="map-source" onClick={() => setOnly(only === s.key ? null : s.key)} opacity={!only || only === s.key ? 1 : 0.35}>
            <circle cx={s.x} cy={s.y} r={13} fill={s.color} />
            <text x={s.x} y={s.y + (s.y > CY ? 30 : -21)} textAnchor="middle" className="map-source-label">{s.label}{counts.get(s.key) ? ` · ${counts.get(s.key)}` : ""}</text>
          </g>
        ))}
        {pts.map((p) => {
          const ring = p.n.direction === "long" ? "var(--pos)" : p.n.direction === "short" ? "var(--neg)" : "var(--border)";
          const href = p.n.cardId ? `/ideas?days=30&card=${p.n.cardId}#card-${p.n.cardId}` : chartUrl(p.n.symbol);
          return (
            <a key={p.n.symbol} href={href} target={p.n.cardId ? undefined : "_blank"} rel="noreferrer" onMouseEnter={() => setHover(p.n.symbol)}>
              <g opacity={lit(p) ? 1 : 0.18}>
                <circle cx={p.x} cy={p.y} r={p.r} fill="var(--surface-1)" stroke={ring} strokeWidth={p.n.cardId ? 3 : 1.5} />
                <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="map-node-label" style={{ fontSize: Math.max(8, Math.min(12, p.r * 0.75)) }}>{p.n.symbol}</text>
              </g>
            </a>
          );
        })}
      </svg>
      {hovered && (
        <div className="map-tip" style={{ left: `${(hovered.x / W) * 100}%`, top: `${(hovered.y / H) * 100}%` }}>
          <div><b>{hovered.n.symbol}</b> <span className="muted">· {hovered.n.links.length} source{hovered.n.links.length > 1 ? "s" : ""}</span>{hovered.n.cardId ? <span className={hovered.n.direction === "long" ? "pos" : "neg"}> · card #{hovered.n.cardId} {hovered.n.direction}{hovered.n.confidence !== null ? `, confidence ${hovered.n.confidence}` : ""}</span> : null}</div>
          {hovered.n.links.map((l) => <div key={l.source} className="small"><span style={{ color: src.get(l.source)!.color }}>●</span> {src.get(l.source)!.label}: <span className="secondary">{l.note}</span></div>)}
          <div className="small muted">{hovered.n.cardId ? "click: open the card" : "click: open on TradingView"}</div>
        </div>
      )}
    </div>
  );
}
