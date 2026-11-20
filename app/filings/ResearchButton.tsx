"use client";

import LinkedText from "@/components/LinkedText";
import { useState } from "react";

/** Send one lead to research now (as Vadim's observation, so it scores as his). */
export default function ResearchButton({ observation, ticker, from }: { observation: string; ticker?: string | null; from: { label: string; url?: string | null } }) {
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation, tickers: ticker ? [ticker] : [], kind: "event", direct: true, from }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? `card #${j.cardId}: ${String(j.status).replace("_", " ")}` : (j.errors ?? ["failed"]).join("; "));
  }
  if (state === "idle") return <button className="chip" onClick={go}>Research it</button>;
  if (state === "busy") return <span className="small muted">researching… a minute or two</span>;
  const card = state.match(/^card #(\d+)/)?.[1];
  return <span className="small">{card ? <a href={`/ideas?days=1&card=${card}#card-${card}`}>{state}</a> : <span className="neg"><LinkedText text={state} /></span>}</span>;
}
