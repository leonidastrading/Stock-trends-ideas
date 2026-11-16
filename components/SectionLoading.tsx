/** A placeholder for one section of a page that is still loading. */
export default function SectionLoading({ label, height = 120 }: { label: string; height?: number }) {
  return (
    <div className="section" role="status" aria-live="polite">
      <p className="small muted">Loading {label}…</p>
      <div className="skeleton" style={{ height }} />
    </div>
  );
}
