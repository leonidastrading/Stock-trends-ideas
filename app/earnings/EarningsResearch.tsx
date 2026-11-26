"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Write this setup's card now (the earnings desk's own card), instead of waiting for the nightly pass. */
export default function EarningsResearch({ id, symbol }: { id: number; symbol: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/earnings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "research", id }) }).catch(() => null);
    if (!res) { setState("Lost the connection while it ran; if it finishes, the card shows here after a reload."); return; }
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    if (res.ok && j.ok) { setState("done"); router.refresh(); } else setState((j.errors ?? ["failed"]).join("; "));
  }
  if (state === "idle") return <button onClick={go} title={`Write the earnings desk's card on ${symbol} now`}>Research {symbol} now</button>;
  if (state === "busy") return <span className="muted">Researching… about a minute.</span>;
  if (state === "done") return <span className="tag ok">card written</span>;
  return <span className="neg">{state}</span>;
}
