"use client";

import { useState } from "react";

/** Start an investigation from a card: the scout checks the card's claims and follows the leads (Investigate tab). */
export default function CardInvestigate({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "busy" | { id: number } | { error: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] })) : { errors: ["network error"] };
    setState(res?.ok && j.ok ? { id: Number(j.id) } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button className="small" onClick={go} title="The scout checks this card's claims against public records (contracts, lobbying, court dockets, filings, web search) and follows the leads. Takes 1-3 minutes; the report appears on the Investigate tab. The card itself is not changed.">Investigate</button>;
  if (state === "busy") return <span className="muted small">starting…</span>;
  if ("id" in state) return <a className="small" href={`/investigate#inv-${state.id}`}>Investigating (1-3 min) → report</a>;
  return <span className="neg small">{state.error}</span>;
}
