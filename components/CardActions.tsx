"use client";

import { useState } from "react";

/** Send to the Swing ideas log, or mark the invalidation as met. Both are one tap and recorded. */
export default function CardActions({ cardId, canSend, sent, open, swingConfigured }: { cardId: number; canSend: boolean; sent: boolean; open: boolean; swingConfigured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function post(path: string, body?: unknown, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
    setBusy(false);
    if (!res.ok || !j.ok) return setMsg((j.errors ?? ["failed"]).join("; "));
    location.reload();
  }

  return (
    <>
      {canSend && !sent && (
        <button className="primary" disabled={busy || !swingConfigured} title={swingConfigured ? "" : "Set SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD"}
          onClick={() => post(`/api/cards/${cardId}/send`, {}, "Send this card to the Swing ideas log as a paper idea? Its paper account will place a market order (queued for the open if the market is closed).")}>
          {busy ? "Sending…" : "Send to Swing ideas (paper)"}
        </button>
      )}
      {sent && <span className="tag ok">sent to Swing ideas</span>}
      {open && (
        <button disabled={busy} onClick={() => post(`/api/cards/${cardId}/invalidate`, { note: prompt("What proved the thesis wrong? (optional)") ?? "" }, "Mark the invalidation as met? The paper track exits at the next open. This cannot be undone.")}>
          Invalidation met
        </button>
      )}
      {msg && <span className="small neg">{msg}</span>}
    </>
  );
}
