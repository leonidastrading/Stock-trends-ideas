"use client";

import { useState } from "react";

/** One tap: send a promoted earnings setup to the Swing ideas log (paper, earnings section). */
export default function EarningsSend({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/earnings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send", id }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? "sent" : (j.errors ?? ["failed"]).join("; "));
  }
  if (state === "idle") return <button className="primary" onClick={go}>Send to Swing ideas (paper)</button>;
  if (state === "busy") return <span className="muted">sending…</span>;
  if (state === "sent") return <span className="tag ok">sent to Swing ideas</span>;
  return <span className="neg">{state}</span>;
}
