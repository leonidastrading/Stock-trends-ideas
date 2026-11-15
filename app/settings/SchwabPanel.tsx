"use client";

import { useState } from "react";

type Result = { symbol: string; pctFloat: number | null; daysToCover: number | null; fields: Record<string, number>; squeeze: string | null };

/** Settings → Schwab: connect (weekly sign-in), test on one stock, disconnect. */
export default function SchwabPanel({ configured, connected, hoursLeft, expiresLabel, message }: { configured: boolean; connected: boolean; hoursLeft: number | null; expiresLabel: string | null; message: string | null }) {
  const [sym, setSym] = useState("GME");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Result | string | null>(null);

  async function call(payload: Record<string, unknown>) {
    setBusy(true); setOut(null);
    const res = await fetch("/api/schwab", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setOut((j.errors ?? ["failed"]).join("; "));
    if (payload.action === "disconnect") return location.reload();
    setOut(j.result as Result);
  }

  const MESSAGES: Record<string, string> = {
    connected: "Connected to Schwab.",
    "missing-settings": "Set SCHWAB_APP_KEY, SCHWAB_APP_SECRET and SCHWAB_CALLBACK_URL in Vercel first (see below), then redeploy.",
    "start-again": "The sign-in link expired or came from another browser. Press Connect Schwab again.",
  };
  return (
    <>
      {message && <p className={`small ${message === "connected" ? "pos" : "neg"}`}>{MESSAGES[message] ?? `Schwab sign-in failed: ${message}`}</p>}
      <p>
        {!configured ? <span className="warn">Not set up.</span> : connected ? <span className="pos">Connected</span> : <span className="neg">Not connected{hoursLeft !== null && hoursLeft <= 0 ? " (the weekly sign-in lapsed)" : ""}.</span>}
        {connected && expiresLabel && <span className="small secondary"> · sign in again by {expiresLabel}{hoursLeft !== null && hoursLeft < 48 ? <b className="warn"> ({hoursLeft} hours left)</b> : null}</span>}
      </p>
      {configured && (
        <div className="toolbar">
          <a className="button primary" href="/api/schwab/login">{connected ? "Sign in again (renews 7 days)" : "Connect Schwab"}</a>
          {connected && (
            <>
              <input value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} aria-label="Ticker to test" style={{ width: 90 }} />
              <button disabled={busy || !sym} onClick={() => call({ action: "test", symbol: sym })}>{busy ? "…" : "Test short interest"}</button>
              <button disabled={busy} onClick={() => confirm("Disconnect Schwab? The scout stops reading short interest until you connect again.") && call({ action: "disconnect" })}>Disconnect</button>
            </>
          )}
        </div>
      )}
      {typeof out === "string" && <p className="small neg">{out}</p>}
      {out && typeof out === "object" && (
        <p className="small">
          <b>{out.symbol}</b>: {out.pctFloat !== null ? `${out.pctFloat}% of float short` : "no % of float"} · {out.daysToCover !== null ? `${out.daysToCover} days to cover` : "no days to cover"}{out.squeeze ? ` · squeeze risk ${out.squeeze}` : ""}
          <span className="muted"> · fields Schwab sent: {Object.keys(out.fields).length ? Object.entries(out.fields).map(([k, v]) => `${k} ${v}`).join(", ") : "none with 'short' in the name"}</span>
        </p>
      )}
    </>
  );
}
