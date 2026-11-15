"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** A follow-up investigation: a new question, starting from this report's findings, with fresh record lookups. */
export default function DigDeeper({ id, previous, suggestions }: { id: number; previous: string; suggestions: string[] }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "started" | string>("idle");
  const router = useRouter();
  async function go(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setState("busy");
    const text = `Follow-up to investigation #${id}. New question: ${q.trim()}\n\nWhat the earlier investigation found (build on it; do not repeat lookups that already came back empty unless the question needs them):\n${previous}`;
    const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    if (res.ok && j.ok) { setState("started"); setQ(""); router.refresh(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else setState((j.errors ?? ["failed"]).join("; "));
  }
  return (
    <form onSubmit={go} className="dig-deeper">
      <div className="small"><b>Dig deeper</b> <span className="muted">a new investigation from a follow-up question; it starts from these findings and pulls fresh records</span></div>
      {suggestions.length > 0 && (
        <div className="chips small">{suggestions.slice(0, 4).map((s) => <button key={s} type="button" className="chip" onClick={() => setQ(s)}>{s.length > 90 ? `${s.slice(0, 88)}…` : s}</button>)}</div>
      )}
      <div className="toolbar" style={{ margin: "6px 0 0" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Ares Capital (NASDAQ: ARCC), not Arabian Cement: what does the record show?" style={{ flex: 1, minWidth: 260 }} disabled={state === "busy"} />
        <button className="primary" type="submit" disabled={state === "busy" || !q.trim()}>{state === "busy" ? "Starting…" : "Investigate"}</button>
      </div>
      {state === "started" && <p className="small">Started: the new investigation is at the top of this page (1-3 minutes).</p>}
      {state !== "idle" && state !== "busy" && state !== "started" && <p className="small neg">{state}</p>}
    </form>
  );
}
