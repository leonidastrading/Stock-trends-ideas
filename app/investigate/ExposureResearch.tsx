"use client";

import LinkedText from "@/components/LinkedText";
import { useState } from "react";

/** Research one exposure from an investigation (scores as "Scout · investigations"). */
export default function ExposureResearch({ id, ticker }: { id: number; ticker: string }) {
  const [state, setState] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "research", id, ticker }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button className="small" onClick={go}>Research {ticker}</button>;
  if (state === "busy") return <span className="muted small">researching… a minute or two</span>;
  return state.cardId ? <a className="small" href={`/ideas?days=7&card=${state.cardId}#card-${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="neg small"><LinkedText text={state.error} /></span>;
}
