"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Send to the Swing ideas log, or mark the invalidation as met. Both are one tap and recorded. */
export default function CardActions({ cardId, canSend, sent, open, swingConfigured, excluded = false }: { cardId: number; canSend: boolean; sent: boolean; open: boolean; swingConfigured: boolean; excluded?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // What was done here, shown at once; the page's data is refreshed in place (no reload, the scroll position stays).
  const [done, setDone] = useState<"sent" | "invalidated" | "excluded" | null>(null);
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ verdict: string; summary: string; fresh: boolean } | null>(null);

  // "Still valid?": the scout re-reads the card against what happened since (about a minute). The check runs on the
  // server to the end even if this page is left; the answer is saved and shown on the card (under these buttons too).
  async function recheck() {
    setChecking(true);
    setMsg(null);
    const res = await fetch(`/api/cards/${cardId}/recheck`, { method: "POST" }).catch(() => null);
    const j = res ? await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] })) : { errors: ["network error"] };
    if (!res?.ok || !j.ok) { setChecking(false); return setMsg((j.errors ?? ["failed"]).join("; ")); }
    if (j.recheck) { setChecking(false); setCheck({ verdict: j.recheck.verdict, summary: j.recheck.summary, fresh: false }); return router.refresh(); }
    // Started: look every few seconds until the answer is saved (or it fails, or two and a half minutes pass).
    const started = Date.parse(j.runningSince ?? new Date().toISOString());
    for (let i = 0; i < 38; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await fetch(`/api/cards/${cardId}/recheck`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (s?.recheck && Date.parse(s.recheck.checkedAt) >= started - 1000) { setChecking(false); setCheck({ verdict: s.recheck.verdict, summary: s.recheck.summary, fresh: true }); return router.refresh(); }
      if (s && !s.runningSince) { setChecking(false); return setMsg(s.error ?? "the check stopped without an answer; press Still valid? again"); }
    }
    setChecking(false);
    setMsg("still checking; the answer will appear on this card when it is done");
  }

  async function post(path: string, body?: unknown, confirmText?: string, what?: "sent" | "invalidated" | "excluded") {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    setDone(what ?? null);
    router.refresh();
  }

  return (
    <>
      {done === "sent" && !sent && <span className="tag ok">sent to Swing ideas</span>}
      {done === "invalidated" && <span className="tag">invalidation recorded: exits at the next open</span>}
      {done === "excluded" && <span className="tag">left out of scoring</span>}
      {canSend && !sent && !excluded && done !== "sent" && (
        <button className="primary" disabled={busy || !swingConfigured} title={swingConfigured ? "Logs a paper idea; its paper account places a market order (queued for the open if the market is closed)" : "Set SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD"}
          onClick={() => post(`/api/cards/${cardId}/send`, undefined, undefined, "sent")}>
          {busy ? "Sending…" : "Send to Swing ideas (paper)"}
        </button>
      )}
      {sent && <span className="tag ok">sent to Swing ideas</span>}
      {open && !done && (
        <button disabled={busy} onClick={() => post(`/api/cards/${cardId}/invalidate`, { note: prompt("What proved the thesis wrong? (optional)") ?? "" }, "Mark the invalidation as met? The paper track exits at the next open. This cannot be undone.", "invalidated")}>
          Invalidation met
        </button>
      )}
      {open && !excluded && !done && (
        <button disabled={busy} className="small" title="The ticker is not the company the card is about (e.g. a reused symbol)" onClick={() => {
          const note = prompt("What is this ticker actually? (e.g. \"SATS is now a Strive preferred; EchoStar trades as ECHO\")");
          if (note) post(`/api/cards/${cardId}/exclude`, { note }, "Leave this card's paper track out of every score? The card stays as written; this cannot be undone.", "excluded");
        }}>
          Wrong security
        </button>
      )}
      <button disabled={checking} className="small" title="The scout re-reads this card against the price, the news, filings and newer cards since it was written, and says whether the idea still holds. The card itself is not changed." onClick={recheck}>
        {checking ? "Checking… (about a minute)" : "Still valid?"}
      </button>
      {check && <span className="small"><b>{check.verdict.replace("_", " ")}</b>{check.fresh ? "" : " (checked in the last 15 minutes)"}: {check.summary}</span>}
      {msg && <span className="small neg">{msg}</span>}
    </>
  );
}
