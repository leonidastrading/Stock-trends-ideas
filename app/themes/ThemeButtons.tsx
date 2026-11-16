"use client";

import LinkedText from "@/components/LinkedText";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Research one theme into a scored card. */
export function ThemeResearch({ run, index }: { run: number; index: number }) {
  const [state, setState] = useState<"idle" | "busy" | { cardId?: number; status?: string; error?: string }>("idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/themes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "research", run, index }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? { cardId: j.cardId, status: j.status } : { error: (j.errors ?? ["failed"]).join("; ") });
  }
  if (state === "idle") return <button className="small" onClick={go}>Research it (card)</button>;
  if (state === "busy") return <span className="small muted">Researching… a minute or two.</span>;
  return state.cardId ? <a className="small" href={`/ideas?days=7&card=${state.cardId}#card-${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="small neg"><LinkedText text={state.error} /></span>;
}

/** Read the sources again now (one AI call, within the Themes budget). */
export function ThemesRefresh() {
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  const router = useRouter();
  async function go() {
    setState("busy");
    const res = await fetch("/api/themes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? String(j.result) : (j.errors ?? ["failed"]).join("; "));
    router.refresh();
  }
  return (
    <span className="small">
      <button onClick={go} disabled={state === "busy"}>{state === "busy" ? "Reading your sources… about a minute" : "Refresh now"}</button>
      {state !== "idle" && state !== "busy" && <span className="muted"> {state}</span>}
    </span>
  );
}
