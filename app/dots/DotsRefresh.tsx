"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Run the Dots desk now (one AI call, within its own daily budget). */
export default function DotsRefresh() {
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  const router = useRouter();
  async function go() {
    setState("busy");
    const res = await fetch("/api/dots", { method: "POST" }).catch(() => null);
    const j = res ? await res.json().catch(() => ({ errors: [`HTTP ${res.status}`] })) : { errors: ["lost the connection; it may still finish, reload in a minute"] };
    setState(res?.ok && j.ok ? String(j.result) : (j.errors ?? ["failed"]).join("; "));
    router.refresh();
  }
  return (
    <span className="small">
      <button onClick={go} disabled={state === "busy"}>{state === "busy" ? "Reading a week of news… about a minute" : "Refresh now"}</button>
      {state !== "idle" && state !== "busy" && <span className="muted"> {state}</span>}
    </span>
  );
}
