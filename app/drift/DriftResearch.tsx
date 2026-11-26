"use client";

import LinkedText from "@/components/LinkedText";
import { useState } from "react";

/** Research one drift setup now (as the down-drift desk, so it scores there). */
export default function DriftResearch({ symbol, again = false, small = false }: { symbol: string; /** A card already exists: the button says so. */ again?: boolean; /** A compact button for a table cell. */ small?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/drift", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button className={small ? "chip" : undefined} onClick={go} title={again ? `A fresh card on ${symbol} as the down-drift desk; the earlier card stays as it is` : `A card on ${symbol} as the down-drift desk`}>{small ? (again ? "Research again" : "Research") : `Research ${symbol} ${again ? "again" : "now"}`}</button>;
  if (state === "busy") return <span className="muted">Researching… a minute or two.</span>;
  return state.cardId ? <a href={`/cards/${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="neg"><LinkedText text={state.error} /></span>;
}
