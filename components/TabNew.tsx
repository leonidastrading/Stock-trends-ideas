"use client";

import { useEffect, useState } from "react";

/**
 * "· 2 new" on a page's own switcher (Down drift / Earnings drift): how many items the OTHER page has that you have
 * not seen, so a red count on the menu leads somewhere. Reads the menu's own record of when you last opened each page.
 */
export default function TabNew({ tab }: { tab: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    const check = async () => {
      try {
        const seen = JSON.parse(localStorage.getItem("scout-seen") ?? "{}") as Record<string, string>;
        if (!seen[tab]) return;
        const j = await (await fetch(`/api/badges?s=${encodeURIComponent(JSON.stringify({ [tab]: seen[tab] }))}`, { cache: "no-store" })).json();
        if (!off && j.ok) setN(Number(j.counts?.[tab] ?? 0));
      } catch {
        /* offline or no storage: no count */
      }
    };
    // After the menu has recorded this visit.
    const t = setTimeout(check, 600);
    return () => { off = true; clearTimeout(t); };
  }, [tab]);
  return n > 0 ? <span className="nav-badge" style={{ marginLeft: 6 }} title={`${n} new since you last opened it`}>{n}</span> : null;
}
