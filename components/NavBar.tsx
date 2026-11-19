"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const LINKS: Array<{ href: string; label: string; badge?: string }> = [
  { href: "/", label: "Home" }, { href: "/ideas", label: "Ideas", badge: "ideas" }, { href: "/favorites", label: "★ Favorites" }, { href: "/news", label: "News", badge: "news" },
  { href: "/drift", label: "Drift", badge: "drift" }, { href: "/rumors", label: "Rumors", badge: "rumors" }, { href: "/themes", label: "Themes", badge: "themes" }, { href: "/pharma", label: "Pharma" }, { href: "/positioning", label: "Positioning" }, { href: "/chart", label: "Chart" }, { href: "/investigate", label: "Investigate", badge: "investigate" },
  { href: "/map", label: "Map" }, { href: "/chat", label: "Chat" }, { href: "/notice", label: "I noticed something" }, { href: "/inbox", label: "Inbox", badge: "inbox" },
  { href: "/filings", label: "Filings", badge: "filings" }, { href: "/congress", label: "Congress", badge: "congress" }, { href: "/watchlist", label: "Watch-list", badge: "watchlist" },
  { href: "/scoreboard", label: "Scoreboard" }, { href: "/scoring", label: "Scoring" }, { href: "/chatter", label: "Chatter test" }, { href: "/settings", label: "Settings" },
];
/** Pages that belong to a tab (the Drift tab also covers the earnings view). */
const TAB_OF: Record<string, string> = { "/earnings": "drift" };
const KEY = "scout-seen";
const POLL_MS = 90_000;

const readSeen = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const writeSeen = (s: Record<string, string>) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } };

/** The menu, with a red count on a tab when something new has appeared there since you last opened it (checked every 45 seconds). */
export default function NavBar() {
  const path = usePathname();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const current = TAB_OF[path] ?? LINKS.find((l) => l.href !== "/" && path.startsWith(l.href))?.badge ?? null;

  const poll = useCallback(async () => {
    const seen = readSeen();
    const now = new Date().toISOString();
    // First visit: start counting from now (no badges for everything that already exists).
    for (const l of LINKS) if (l.badge && !seen[l.badge]) seen[l.badge] = now;
    if (current) seen[current] = now;
    writeSeen(seen);
    try {
      const r = await fetch(`/api/badges?s=${encodeURIComponent(JSON.stringify(seen))}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setCounts({ ...j.counts, ...(current ? { [current]: 0 } : {}) });
    } catch {
      /* offline: keep the last counts */
    }
  }, [current]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => { if (document.visibilityState === "visible") void poll(); }, POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [poll]);

  return (
    <nav>
      <span className="brand">Trend scout</span>
      {LINKS.map((l) => {
        const c = l.badge && l.badge !== current ? counts[l.badge] ?? 0 : 0;
        return (
          <Link key={l.href} href={l.href} className="nav-link">
            {l.label}
            {c > 0 && <span className="nav-badge" title={`${c >= 100 ? "100+" : c} new since you last looked`}>{c >= 100 ? "99+" : c}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
