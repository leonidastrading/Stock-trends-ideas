"use client";

import { useState } from "react";

/** Research one catalyst into a card (scored as human-originated), like the Home search's "Research it". */
export default function ResearchButton({ symbol, term, observation }: { symbol: string; term: string; observation: string }) {
  const [state, setState] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation, term, tickers: [symbol], kind: "event" }) }).catch(() => null);
    if (!res) { setState({ error: "Lost the connection while it ran; if it finishes, the card shows up on Ideas and here." }); return; }
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button type="button" className="chip" onClick={go}>Research it</button>;
  if (state === "busy") return <span className="small muted">Researching… a minute or two.</span>;
  return state.cardId ? <a className="small" href={`/ideas?days=365&card=${state.cardId}#card-${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="small neg">{state.error}</span>;
}
