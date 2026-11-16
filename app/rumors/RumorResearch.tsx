"use client";

import LinkedText from "@/components/LinkedText";
import { useState } from "react";

/** Check one rumor against public evidence now (scores as "Scout · rumors (checked)"). */
export default function RumorResearch({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/rumors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "research", id }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button className="small" onClick={go}>Check it (research)</button>;
  if (state === "busy") return <span className="muted">Checking the facts… a minute or two.</span>;
  return state.cardId ? <a href={`/ideas?days=7&card=${state.cardId}#card-${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="neg"><LinkedText text={state.error} /></span>;
}
