/** Shown the moment any tab is clicked, while the page's data loads (so a click never looks ignored). */
export default function Loading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <div className="page-loading-bar" />
      <p className="small muted">Loading…</p>
      <div className="skeleton" style={{ height: 38, maxWidth: 420 }} />
      <div className="skeleton" style={{ height: 160 }} />
      <div className="skeleton" style={{ height: 220 }} />
    </div>
  );
}
