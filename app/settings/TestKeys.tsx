"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Runs the investigation-key test now and refreshes the table with the outcome. */
export default function TestKeys() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [msg, setMsg] = useState("");
  const run = async () => {
    setState("busy");
    setMsg("");
    try {
      const res = await fetch("/api/keycheck", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error ?? `status ${res.status}`);
      setState("idle");
      setMsg(`Tested: ${j.checks.map((c: { key: string; status: string }) => `${c.key.replace(/_(API_KEY|TOKEN)$/, "")} ${c.status}`).join(" · ")}`);
      router.refresh();
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <p className="small">
      <button className="chip" onClick={run} disabled={state === "busy"}>{state === "busy" ? "Testing keys…" : "Test keys"}</button>{" "}
      <span className={state === "error" ? "neg" : "muted"}>{msg || "Brave Search, CourtListener, EDINET and DART: one small real call each (usually under a minute; up to 2 minutes the first time for DART)."}</span>
    </p>
  );
}
