"use client";

import { useState } from "react";

type Result = { symbol: string; line: string | null; source?: string | null; shortError?: string | null; schwab: { shortFields?: Record<string, number>; shareFields?: Record<string, number>; error?: string } };

/** Settings → Schwab: connect (weekly sign-in), test on one stock, disconnect. */
export default function SchwabPanel({ configured, connected, hoursLeft, expiresLabel, message, mode = "own", canRefresh = true, lastError = null }: { configured: boolean; connected: boolean; hoursLeft: number | null; expiresLabel: string | null; message: string | null; mode?: "shared" | "own"; canRefresh?: boolean; lastError?: string | null }) {
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
      {mode === "shared" && (
        <p className="small secondary">Using oo-trading&apos;s Schwab login (its Redis store). Sign in again there when it lapses.{!canRefresh ? " Add SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET (the same as oo-trading) so the scout can refresh the 30-minute token itself; without them it works only while oo-trading keeps the token fresh." : ""}{lastError ? <span className="neg"> Last error there: {lastError}</span> : null}</p>
      )}
      <p>
        {!configured ? <span className="warn">Not set up.</span> : connected ? <span className="pos">Connected</span> : <span className="neg">Not connected{hoursLeft !== null && hoursLeft <= 0 ? " (the weekly sign-in lapsed)" : ""}.</span>}
        {connected && expiresLabel && <span className="small secondary"> · sign in again by {expiresLabel}{hoursLeft !== null && hoursLeft < 48 ? <b className="warn"> ({hoursLeft} hours left)</b> : null}</span>}
      </p>
      {configured && (
        <div className="toolbar">
          {mode === "own" && <a className="button primary" href="/api/schwab/login">{connected ? "Sign in again (renews 7 days)" : "Connect Schwab"}</a>}
          {connected && (
            <>
              <input value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} aria-label="Ticker to test" style={{ width: 90 }} />
              <button disabled={busy || !sym} onClick={() => call({ action: "test", symbol: sym })}>{busy ? "…" : "Test short interest"}</button>
              {mode === "own" && <button disabled={busy} onClick={() => confirm("Disconnect Schwab? The scout stops reading short interest until you connect again.") && call({ action: "disconnect" })}>Disconnect</button>}
            </>
          )}
        </div>
      )}
      {typeof out === "string" && <p className="small neg">{out}</p>}
      {out && typeof out === "object" && (
        <div className="small">
          <div><b>{out.symbol}</b>: {out.line ? <>{out.line} <span className="muted">({out.source})</span></> : <span className="neg">no short-interest report ({out.shortError ?? "no source answered"})</span>}</div>
          <div className="muted">
            Schwab sent: {out.schwab.error ? <span className="neg">{out.schwab.error}</span> : <>
              short fields {Object.keys(out.schwab.shortFields ?? {}).length ? Object.entries(out.schwab.shortFields!).map(([k, v]) => `${k} ${v}`).join(", ") : "none"};
              share fields {Object.keys(out.schwab.shareFields ?? {}).length ? Object.entries(out.schwab.shareFields!).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(", ") : "none"}
            </>}
          </div>
        </div>
      )}
    </>
  );
}
