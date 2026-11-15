"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { renderReply } from "./render";
import { useTickers } from "@/components/useTickers";
import { shownUserText } from "@/lib/scout/chat-text";

interface Msg { role: "user" | "assistant"; content: string }
interface Past { id: number; createdAt: string; first: string | null; turns: number }

const KEY = "scout-chat-thread";
const STARTERS = [
  "What are the strongest open ideas right now, and what would kill each one?",
  "Does anything in today's headlines touch my cards?",
  "What are insiders, Congress and the options log pointing at this week?",
  "Which cards are losing against SPY, and is the thesis still alive?",
];

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export default function ChatWindow({ past, tickers, cardIds = {} }: { past: Past[]; tickers: string[]; cardIds?: Record<string, number> }) {
  const [thread, setThread] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const { known, cards } = useTickers(msgs.filter((m) => m.role === "assistant").map((m) => m.content), tickers, cardIds);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  async function load(id: number) {
    const r = await fetch(`/api/chat?thread=${id}`);
    if (!r.ok) return newChat();
    const j = await r.json();
    setThread(j.thread);
    setStartedAt(j.createdAt);
    setBriefing(j.briefingChars);
    setMsgs(j.messages.map((m: Msg) => ({ role: m.role, content: m.content })));
    try { localStorage.setItem(KEY, String(j.thread)); } catch { /* storage unavailable */ }
  }

  function newChat() {
    setThread(null);
    setStartedAt(null);
    setBriefing(null);
    setMsgs([]);
    try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  }

  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
    if (saved) void load(Number(saved));
  }, []);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setBusy(true);
    setText("");
    setStatus(thread ? "Thinking…" : "Reading everything the scout knows (cards, stories, filings, options, Congress, headlines)…");
    setMsgs((x) => [...x, { role: "user", content: m }, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: thread ?? undefined, message: m }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] }));
        throw new Error((j.errors ?? [j.error ?? "failed"]).join("; "));
      }
      const id = Number(res.headers.get("x-thread-id"));
      if (id && id !== thread) {
        setThread(id);
        setStartedAt(new Date().toISOString());
        setBriefing(Number(res.headers.get("x-briefing-chars")) || null);
        try { localStorage.setItem(KEY, String(id)); } catch { /* storage unavailable */ }
      }
      setStatus("Thinking…");
      // The reply arrives in pieces; it is shown once, whole, when it is done (with a word count meanwhile).
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let reply = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += dec.decode(value, { stream: true });
        const words = reply.trim().split(/\s+/).length;
        setStatus(`Writing the reply… ${words.toLocaleString("en-US")} word${words === 1 ? "" : "s"} so far`);
      }
      reply += dec.decode();
      setMsgs((x) => { const y = x.slice(); y[y.length - 1] = { role: "assistant", content: reply || "(No reply.)" }; return y; });
    } catch (err) {
      setMsgs((x) => { const y = x.slice(); y[y.length - 1] = { role: "assistant", content: `(Error: ${err instanceof Error ? err.message : String(err)})` }; return y; });
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <div className="chat">
      <div className="chat-bar small secondary">
        <span>{thread ? <>Chat started {startedAt ? when(startedAt) : ""} ET · memory: {briefing ? `${Math.round(briefing / 1000)}k characters of scout data` : "loaded"} from that moment</> : "New chat: the scout's latest data is loaded when you send the first message."}</span>
        <span style={{ display: "flex", gap: 8 }}>
          {past.length > 0 && (
            <select value="" onChange={(e) => e.target.value && load(Number(e.target.value))} aria-label="Earlier chats">
              <option value="">Earlier chats…</option>
              {past.map((p) => <option key={p.id} value={p.id}>{when(p.createdAt)} · {(p.first ?? "(empty)").slice(0, 50)}</option>)}
            </select>
          )}
          <button onClick={newChat} disabled={busy}>New chat (fresh data)</button>
        </span>
      </div>

      <div className="chat-log card" ref={log}>
        {msgs.length === 0 && (
          <div className="small secondary">
            <p>Ask anything about the scout&apos;s ideas, the news, filings, options flags, Congress trades or the market. Some starting points:</p>
            <div className="chips">{STARTERS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-who small muted">{m.role === "user" ? "You" : "Scout"}</div>
            <div className="chat-text">{m.content ? (m.role === "assistant" ? renderReply(m.content, known, cards) : shownUserText(m.content)) : (busy && i === msgs.length - 1 ? <span className="muted">{status ?? "…"}</span> : "")}</div>
          </div>
        ))}
        {!busy && msgs.length > 0 && msgs[msgs.length - 1].role === "user" && (
          <p className="small muted">The reply to this is still being written or was interrupted. <button className="chip" onClick={() => thread && load(thread)}>Refresh</button></p>
        )}
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the scout… (Enter to send, Shift+Enter for a new line)"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} disabled={busy} />
        <button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? "…" : "Send"}</button>
      </form>
      <p className="small muted">Uses the model set on Settings; each reply counts toward the daily AI cap. Paper only: the chat can discuss and suggest, never trade.</p>
    </div>
  );
}
