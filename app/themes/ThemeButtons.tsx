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
  return state.cardId ? <a className="small" href={`/cards/${state.cardId}`}>card #{state.cardId}: {String(state.status).replace("_", " ")}</a> : <span className="small neg"><LinkedText text={state.error} /></span>;
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

/** Send the theme's main ticker to the Swing ideas log (paper), once. */
export function ThemeSend({ run, index, ticker, side, sent, configured }: { run: number; index: number; ticker: string; side: "long" | "short"; sent: boolean; configured: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>(sent ? "sent" : "idle");
  async function go() {
    setState("busy");
    const res = await fetch("/api/themes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send", run, index }) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setState(res.ok && j.ok ? "sent" : (j.errors ?? ["failed"]).join("; "));
  }
  if (state === "sent") return <span className="tag ok">{side} {ticker} sent to Swing ideas</span>;
  if (state === "busy") return <span className="small muted">sending…</span>;
  return (
    <span className="small">
      <button className="primary" onClick={go} disabled={!configured} title={configured ? `Logs a paper idea: ${side} ${ticker}, exits after 14 days` : "Set SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD"}>Send {side} {ticker} to Swing ideas (paper)</button>
      {state !== "idle" && <span className="neg"> <LinkedText text={state} /></span>}
    </span>
  );
}
