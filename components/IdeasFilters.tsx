"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export interface FilterGroup { param: string; title: string; options: Array<{ value: string; label: string; count: number }>; selected: string[]; scores?: boolean }

const OPEN_KEY = "ideas-filters-open";
const SCORES_KEY = "ideas-scores-open";
const readFlag = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const writeFlag = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* storage unavailable */ } };

/**
 * The Ideas filters as one form: any number of choices per group (none = any), applied together with Apply.
 * Whether the panel and its Scores section are open is remembered in this browser, across refreshes and Apply.
 */
export default function IdeasFilters({ days, sort, rev, sorts, groups, summary, keep }: {
  days: string; sort: string; /** The reversed order of the chosen sort (oldest first, lowest first, ...). */ rev: boolean;
  sorts: Array<{ value: string; label: string; fwd: string; rev: string }>; groups: FilterGroup[]; summary: string; keep: Record<string, string>;
}) {
  const router = useRouter();
  const applied = useMemo(() => Object.fromEntries(groups.map((g) => [g.param, g.selected])), [groups]);
  const [sel, setSel] = useState<Record<string, string[]>>(applied);
  const [d, setD] = useState(days);
  const [s, setS] = useState(sort);
  const [r, setR] = useState(rev);
  const [open, setOpen] = useState(false);
  const [scoresOpen, setScoresOpen] = useState(false);
  useEffect(() => { setOpen(readFlag(OPEN_KEY)); setScoresOpen(readFlag(SCORES_KEY) || groups.some((g) => g.scores && g.selected.length)); }, [groups]);
  useEffect(() => { setSel(applied); setD(days); setS(sort); setR(rev); }, [applied, days, sort, rev]);

  const toggle = (param: string, value: string) => setSel((old) => {
    const cur = old[param] ?? [];
    return { ...old, [param]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
  });
  const changed = d !== days || s !== sort || r !== rev || groups.some((g) => [...(sel[g.param] ?? [])].sort().join(",") !== [...g.selected].sort().join(","));
  const apply = (next = sel, nd = d, ns = s, nr = r) => {
    const q = new URLSearchParams();
    if (nd && nd !== "7") q.set("days", nd);
    if (ns && ns !== "best") q.set("sort", ns);
    if (nr) q.set("rev", "1");
    for (const g of groups) if ((next[g.param] ?? []).length) q.set(g.param, next[g.param].join(","));
    for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
    router.push(`/ideas?${q.toString() || "all=1"}#cards`);
  };
  const clear = () => { const empty = Object.fromEntries(groups.map((g) => [g.param, [] as string[]])); setSel(empty); apply(empty); };

  const chips = (g: FilterGroup) => (
    <div className="toolbar" key={g.param}>
      <span className="filter-links small">
        <span className="filter-title">{g.title}</span>
        <button type="button" className={`chip${(sel[g.param] ?? []).length === 0 ? " active" : ""}`} onClick={() => setSel((o) => ({ ...o, [g.param]: [] }))}>Any</button>
        {g.options.map((o) => (
          <button type="button" key={o.value} aria-pressed={(sel[g.param] ?? []).includes(o.value)} className={`chip${(sel[g.param] ?? []).includes(o.value) ? " active" : ""}`} onClick={() => toggle(g.param, o.value)}>
            {o.label}<span className="muted"> {o.count}</span>
          </button>
        ))}
      </span>
    </div>
  );

  return (
    <details className="filters-panel" open={open} onToggle={(e) => { const v = (e.currentTarget as HTMLDetailsElement).open; setOpen(v); writeFlag(OPEN_KEY, v); }}>
      <summary className="filters-summary"><b>Filters</b> <span className="muted">· {summary}</span></summary>
      <div className="toolbar">
        <span className="filter-links small">
          <span className="filter-title">Period</span>
          {[["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["365", "1 year"], ["3650", "All dates"]].map(([v, l]) => <button type="button" key={v} className={`chip${d === v ? " active" : ""}`} onClick={() => setD(v)}>{l}</button>)}
        </span>
      </div>
      <div className="toolbar">
        <span className="filter-links small">
          <span className="filter-title">Sort by</span>
          {sorts.map((o) => <button type="button" key={o.value} className={`chip${s === o.value ? " active" : ""}`} onClick={() => setS(o.value)}>{o.label}</button>)}
        </span>
      </div>
      <div className="toolbar">
        <span className="filter-links small">
          <span className="filter-title">Order</span>
          {(() => { const o = sorts.find((x) => x.value === s) ?? sorts[0]; return [[false, o.fwd], [true, o.rev]].map(([v, l]) => <button type="button" key={String(v)} className={`chip${r === v ? " active" : ""}`} onClick={() => setR(v as boolean)}>{l as string}</button>); })()}
        </span>
      </div>
      {groups.filter((g) => !g.scores).map(chips)}
      <details className="score-filters" open={scoresOpen} onToggle={(e) => { const v = (e.currentTarget as HTMLDetailsElement).open; setScoresOpen(v); writeFlag(SCORES_KEY, v); }}>
        <summary className="small">Scores: novelty, materiality, evidence, early, rank{groups.some((g) => g.scores && g.selected.length) ? ` (${groups.filter((g) => g.scores && g.selected.length).length} on)` : ""}</summary>
        {groups.filter((g) => g.scores).map(chips)}
      </details>
      <div className="toolbar filters-actions">
        <button type="button" className="primary" onClick={() => apply()} disabled={!changed}>Apply</button>
        <button type="button" className="chip" onClick={clear}>Clear all</button>
        <span className="small muted">{changed ? "Not applied yet: counts are for the filters now on." : "Tick any number in each group (none = any), then Apply."}</span>
      </div>
    </details>
  );
}
