"use client";

import { useEffect, useState } from "react";
import { useTickers } from "@/components/useTickers";
import { renderReply } from "@/app/chat/render";
import { ATTACHED } from "@/lib/scout/chat-text";

/** The chat page's thread key: a question asked here joins the chat you have open there. */
const KEY = "scout-chat-thread";
/** Questions asked from cards and their answers, kept in this browser so a reload does not lose them. */
const ASKED = "scout-card-asks";

interface Asked { q: string; thread: number | null; askedAt: string; text: string | null }
const readAsked = (): Record<string, Asked> => { try { return JSON.parse(localStorage.getItem(ASKED) ?? "{}") as Record<string, Asked>; } catch { return {}; } };
const saveAsked = (key: string, a: Asked | null) => {
  try {
    const all = readAsked();
    if (a) all[key] = a; else delete all[key];
    // Keep the 60 most recent.
    const kept = Object.fromEntries(Object.entries(all).sort((x, y) => y[1].askedAt.localeCompare(x[1].askedAt)).slice(0, 60));
    localStorage.setItem(ASKED, JSON.stringify(kept));
  } catch { /* storage unavailable */ }
};

/** The scout's reply to a question asked at `askedAt` in a thread (the server saves it even if the page was closed). */
async function savedReply(thread: number, askedAt: string): Promise<string | null> {
  const r = await fetch(`/api/chat?thread=${thread}`, { cache: "no-store" });
  const j = await r.json().catch(() => null) as { messages?: Array<{ role: string; content: string; at?: string }> } | null;
  const msgs = j?.messages ?? [];
  const from = Date.parse(askedAt) - 60_000;
  const i = msgs.findIndex((m) => m.role === "user" && m.at && Date.parse(m.at) >= from);
  if (i < 0) return null;
  const reply = msgs.slice(i + 1).find((m) => m.role === "assistant");
  return reply ? reply.content : null;
}

/**
 * "Ask the scout": a question answered in place, joining the current chat. On a card the whole card is attached
 * by the server (cardId); elsewhere (a rumor) the caller passes its details as `context` and a `subject` line.
 */
export default function CardAsk({ cardId, symbol, tickers, subject, context, noun = "card" }: { cardId?: number; symbol: string; tickers: string[]; subject?: string; context?: string; noun?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ q: string; text: string } | null>(null);
  const { known, cards } = useTickers(answer ? [answer.text] : [], [symbol, ...tickers].filter(Boolean));
  const askKey = cardId ? `card:${cardId}` : `${noun}:${subject ?? symbol}`;

  // After a reload: show the last answer here, or pick up a question still being answered.
  useEffect(() => {
    const a = readAsked()[askKey];
    if (!a) return;
    setOpen(true);
    if (a.text) { setAnswer({ q: a.q, text: a.text }); return; }
    if (!a.thread || Date.now() - Date.parse(a.askedAt) > 15 * 60_000) {
      setAnswer({ q: a.q, text: "(The page reloaded before the answer arrived. If the scout finished it, it is in Chat.)" });
      return;
    }
    let stop = false;
    setBusy("Still answering (picked up after the page reloaded)…");
    const poll = async () => {
      if (stop) return;
      const text = await savedReply(a.thread!, a.askedAt).catch(() => null);
      if (stop) return;
      if (text) { setAnswer({ q: a.q, text }); setBusy(null); saveAsked(askKey, { ...a, text }); return; }
      if (Date.now() - Date.parse(a.askedAt) > 15 * 60_000) { setBusy(null); setAnswer({ q: a.q, text: "(No answer arrived. Try asking again.)" }); return; }
      setTimeout(poll, 4000);
    };
    void poll();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey]);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    let thread: number | undefined;
    try { thread = Number(localStorage.getItem(KEY)) || undefined; } catch { /* storage unavailable */ }
    setBusy(thread ? "Thinking…" : "Loading what the scout knows, then thinking…");
    setAnswer(null);
    const askedAt = new Date().toISOString();
    saveAsked(askKey, { q: question, thread: thread ?? null, askedAt, text: null });
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cardId ? { thread, cardId, message: question } : { thread, message: `About ${subject ?? noun}: ${question}${context ? `${ATTACHED}${context}` : ""}` }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
        throw new Error((j.errors ?? [j.error ?? "failed"]).join("; "));
      }
      const id = Number(res.headers.get("x-thread-id"));
      if (id) try { localStorage.setItem(KEY, String(id)); } catch { /* storage unavailable */ }
      if (id) saveAsked(askKey, { q: question, thread: id, askedAt, text: null });
      // Shown whole when done, like the chat page.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        const words = text.trim().split(/\s+/).length;
        setBusy(`Writing the answer… ${words.toLocaleString("en-US")} word${words === 1 ? "" : "s"} so far`);
      }
      text += dec.decode();
      setAnswer({ q: question, text: text || "(No reply.)" });
      saveAsked(askKey, { q: question, thread: id || null, askedAt, text: text || "(No reply.)" });
      setQ("");
    } catch (err) {
      setAnswer({ q: question, text: `(Error: ${err instanceof Error ? err.message : String(err)})` });
    } finally {
      setBusy(null);
    }
  }

  if (!open) return <button onClick={() => setOpen(true)}>Ask the scout</button>;
  return (
    <div className="card-ask">
      {answer && (
        <div className="card-ask-answer">
          <div className="small muted">You asked: {answer.q} <button type="button" className="link-button" onClick={() => { saveAsked(askKey, null); setAnswer(null); }} title="Remove this answer from the card">clear</button></div>
          <div className="chat-text">{renderReply(answer.text, known, cards)}</div>
          <div className="small"><a href="/chat">Continue in Chat →</a></div>
        </div>
      )}
      <form onSubmit={ask}>
        <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2} placeholder={noun === "card" ? `Ask about this ${symbol} card: is it still on? what would change your mind? how would you trade it?` : `Ask about this ${noun}: is there anything to it? who would it hit? what would confirm it?`}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }} disabled={!!busy} />
        <div className="toolbar" style={{ margin: "6px 0 0" }}>
          <button className="primary" type="submit" disabled={!!busy || !q.trim()}>{busy ? "…" : "Ask"}</button>
          <button type="button" onClick={() => setOpen(false)} disabled={!!busy}>Close</button>
          {busy && <span className="small muted">{busy}</span>}
        </div>
      </form>
      <p className="small muted" style={{ margin: "4px 0 0" }}>{noun === "card" ? "The whole card and its paper track go with your question" : `The full ${noun} goes with your question`}; it joins your current chat. Counts toward the daily AI cap.</p>
    </div>
  );
}
