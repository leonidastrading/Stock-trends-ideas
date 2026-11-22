"use client";

import LinkedText from "@/components/LinkedText";
import { useState } from "react";

/** Research one drift setup now (as the down-drift desk, so it scores there). */
export default function DriftResearch({ symbol }: { symbol: string }) {
  const [state, setState] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/drift", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button onClick={go}>Research {symbol} now</button>;
  if (state === "busy") return <span className="muted">Researching… a minute or two.</span>;
  return state.cardId ? <a href={`/cards/${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="neg"><LinkedText text={state.error} /></span>;
}
