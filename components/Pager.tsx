/** Server-rendered paging and filter links that keep the page's other query parameters. */

type Params = Record<string, string | undefined>;

export function hrefWith(params: Params, change: Params, hash = ""): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...change })) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return `?${s || "all=1"}${hash}`;
}

/** Pure: the slice for a page (1-based, clamped) and the page count. */
export function paginate<T>(items: T[], page: number, size: number): { items: T[]; page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  return { items: items.slice((p - 1) * size, p * size), page: p, pages, total: items.length };
}

export default function Pager({ params, name, page, pages, total, label = "items", hash = "" }: { params: Params; name: string; page: number; pages: number; total: number; label?: string; hash?: string }) {
  if (pages <= 1) return <p className="small muted pager">{total} {label}</p>;
  const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <nav className="small pager">
      {page > 1 ? <a href={hrefWith(params, { [name]: String(page - 1) }, hash)}>← Newer</a> : <span className="muted">← Newer</span>}
      {nums.map((n, i) => (
        <span key={n}>
          {i > 0 && n - nums[i - 1] > 1 ? <span className="muted"> … </span> : null}
          {n === page ? <b className="pager-current">{n}</b> : <a href={hrefWith(params, { [name]: String(n) }, hash)}>{n}</a>}
        </span>
      ))}
      {page < pages ? <a href={hrefWith(params, { [name]: String(page + 1) }, hash)}>Older →</a> : <span className="muted">Older →</span>}
      <span className="muted">· {total} {label}</span>
    </nav>
  );
}

/** A row of filter links; the active one is highlighted. Changing a filter goes back to page 1. */
export function FilterLinks({ params, name, value, options, reset = [] }: { params: Params; name: string; value: string; options: Array<{ value: string; label: string; count?: number }>; reset?: string[] }) {
  const cleared = Object.fromEntries(reset.map((r) => [r, undefined]));
  return (
    <span className="filter-links small">
      {options.map((o) => (
        <a key={o.value} className={`chip${o.value === value ? " active" : ""}`} href={hrefWith(params, { ...cleared, [name]: o.value || undefined })}>
          {o.label}{o.count !== undefined ? <span className="muted"> {o.count}</span> : null}
        </a>
      ))}
    </span>
  );
}
