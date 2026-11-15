"use client";

import { useState } from "react";

/** Start a follow-the-money investigation on one rumor (public records: contracts, lobbying, PAC money). */
export default function RumorInvestigate({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "busy" | "started" | string>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/investigate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? "started" : (j.errors ?? ["failed"]).join("; "));
  }
  if (state === "idle") return <button className="small" onClick={go} title="Follow the money in public records: federal contracts, lobbying filings, PAC and campaign money">Investigate</button>;
  if (state === "busy") return <span className="muted small">starting…</span>;
  if (state === "started") return <a className="small" href="/investigate">Investigating (1-3 min) → Investigate tab</a>;
  return <span className="neg small">{state}</span>;
}
