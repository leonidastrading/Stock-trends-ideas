"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Research a stock or an idea. It runs in the background; the result appears in the list below (and on the menu's badge). */
export default function ResearchForm() {
  const [idea, setIdea] = useState("");
  const [tickers, setTickers] = useState("");
  const [state, setState] = useState<"idle" | "busy" | { ok: boolean; msg: string }>("idle");
  const router = useRouter();

  async function go(e: React.FormEvent) {
    e.preventDefault();
    const syms = tickers.toUpperCase().split(/[\s,]+/).map((s) => s.replace(/^\$/, "")).filter((s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)).slice(0, 5);
    const text = idea.trim() || (syms.length ? `Research ${syms.join(", ")}: is there a trade here now? What is moving it, what is already priced in, and what is the next catalyst?` : "");
    if (text.length < 5) return setState({ ok: false, msg: "Type a ticker or an idea." });
    setState("busy");
    const res = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observation: text, tickers: syms, direct: true, background: true, term: (idea.trim() ? idea.trim().split(/[.!?\n]/)[0] : `Research ${syms.join(", ")}`).slice(0, 80) }) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok || !j.ok) return setState({ ok: false, msg: (j.errors ?? ["could not start"]).join("; ") });
    setIdea(""); setTickers("");
    setState({ ok: true, msg: "Started. It takes a minute or two; the result appears below." });
    router.refresh();
  }

  return (
    <form onSubmit={go} className="research-form">
      <div className="toolbar">
        <input value={tickers} onChange={(e) => setTickers(e.target.value)} placeholder="Ticker(s), e.g. ORCL or ORCL CRWV" aria-label="Tickers" style={{ width: 240, textTransform: "uppercase" }} />
      </div>
      <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="The idea, in a sentence or two (optional with a ticker): what you noticed, and what you think it means." aria-label="Idea" style={{ width: "100%", marginTop: 8 }} />
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={state === "busy"}>{state === "busy" ? "Starting…" : "Research it"}</button>
        {typeof state === "object" && <span className={`small ${state.ok ? "pos" : "neg"}`}>{state.msg}</span>}
      </div>
    </form>
  );
}

/** While anything is still running, refresh the list every 15 seconds. */
export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [running, router]);
  return null;
}
