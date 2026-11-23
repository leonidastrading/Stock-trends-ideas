"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { markSeen } from "@/lib/seen";

const Fresh = createContext<ReadonlySet<string>>(new Set());

/** Remembers (in this browser) which of `keys` you have been shown, so <NewFlag> can mark the ones you have not. */
export function SeenScope({ name, keys, children }: { name: string; keys: string[]; children: React.ReactNode }) {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const joined = keys.join("\n");
  useEffect(() => {
    const list = joined ? joined.split("\n") : [];
    let prev: Record<string, number> = {};
    try { prev = JSON.parse(localStorage.getItem(`seen:${name}`) ?? "{}") ?? {}; } catch { /* no storage: everything shows as new */ }
    const { next, fresh: f } = markSeen(prev, list, Date.now());
    try { localStorage.setItem(`seen:${name}`, JSON.stringify(next)); } catch { /* private window */ }
    setFresh(new Set(f));
  }, [name, joined]);
  return <Fresh.Provider value={fresh}>{children}</Fresh.Provider>;
}

/** A red flag on an item you have not seen before (inside a <SeenScope>). */
export default function NewFlag({ k }: { k: string }) {
  return useContext(Fresh).has(k) ? <span className="new-flag" title="New since you last looked (stays flagged for 15 minutes)">NEW</span> : null;
}
