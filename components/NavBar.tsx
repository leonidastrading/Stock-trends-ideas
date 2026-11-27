"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { openTab, PREV_KEY, SEEN_KEY } from "@/lib/last-visit";

const LINKS: Array<{ href: string; label: string; badge?: string; also?: string[] }> = [
  { href: "/", label: "Home" }, { href: "/ideas", label: "Ideas", badge: "ideas" }, { href: "/research", label: "Research", badge: "research" }, { href: "/favorites", label: "★ Favorites" }, { href: "/news", label: "News", badge: "news" }, { href: "/prs", label: "Press releases" }, { href: "/calendar", label: "Calendar" },
  { href: "/drift", label: "Drift", badge: "drift", also: ["earnings"] }, { href: "/longterm", label: "Long term" }, { href: "/rumors", label: "Rumors", badge: "rumors" }, { href: "/themes", label: "Themes", badge: "themes" }, { href: "/bubbles", label: "Bubbles", badge: "bubbles" }, { href: "/daytrade", label: "Daytrade" }, { href: "/stocktwits", label: "Stocktwits", badge: "stocktwits" }, { href: "/dots", label: "Dots" }, { href: "/pharma", label: "Pharma" }, { href: "/court", label: "Court" }, { href: "/positioning", label: "Positioning" }, { href: "/chart", label: "Chart" }, { href: "/investigate", label: "Investigate", badge: "investigate" },
  { href: "/map", label: "Map" }, { href: "/chat", label: "Chat" }, { href: "/notice", label: "I noticed something" }, { href: "/inbox", label: "Inbox", badge: "inbox" },
  { href: "/filings", label: "Filings", badge: "filings" }, { href: "/congress", label: "Congress", badge: "congress" }, { href: "/watchlist", label: "Watch-list", badge: "watchlist" },
  { href: "/scoreboard", label: "Scoreboard" }, { href: "/scoring", label: "Scoring" }, { href: "/chatter", label: "Chatter test" }, { href: "/settings", label: "Settings" },
];
/**
 * Pages that sit under another tab, with their own "new" count: the Drift tab's second page is the earnings view.
 * Opening one page marks only that page as seen, so the menu keeps its count for the other until you open it.
 */
const PAGE_OF: Record<string, { href: string; tab: string }> = { "/earnings": { href: "/drift", tab: "earnings" }, "/upgrades": { href: "/drift", tab: "upgrades" } };
const KEY = SEEN_KEY;
const readPrev = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(PREV_KEY) ?? "{}"); } catch { return {}; } };
const POLL_MS = 90_000;

const readSeen = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const writeSeen = (s: Record<string, string>) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } };

/** The menu, with a red count on a tab when something new has appeared there since you last opened it (checked every 45 seconds). */
export default function NavBar() {
  const path = usePathname();
  const [counts, setCounts] = useState<Record<string, number>>({});
  // The site was updated since this page was opened (switching tabs keeps the old styles and code): reload.
  const build = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  const active = PAGE_OF[path] ? PAGE_OF[path].href : path === "/" ? "/" : LINKS.find((l) => l.href !== "/" && (path === l.href || path.startsWith(`${l.href}/`)))?.href;
  const current = PAGE_OF[path]?.tab ?? LINKS.find((l) => l.href === active)?.badge ?? null;

  const poll = useCallback(async () => {
    const seen = readSeen();
    const now = new Date().toISOString();
    // First visit: start counting from now (no badges for everything that already exists).
    for (const l of LINKS) if (l.badge && !seen[l.badge]) seen[l.badge] = now;
    // A page under a tab starts from when its tab was last opened (nothing already counted is lost or doubled).
    for (const l of LINKS) for (const t of l.also ?? []) if (!seen[t]) seen[t] = seen[l.badge!] ?? now;
    if (current) {
      // Keep the moment before this visit, so the page can flag what is new since then (see lib/last-visit.ts).
      const next = openTab(seen, readPrev(), current, now);
      seen[current] = now;
      try { localStorage.setItem(PREV_KEY, JSON.stringify(next.prev)); } catch { /* storage unavailable */ }
      window.dispatchEvent(new Event("scout-visit"));
    }
    writeSeen(seen);
    try {
      const r = await fetch(`/api/badges?s=${encodeURIComponent(JSON.stringify(seen))}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setCounts({ ...j.counts, ...(current ? { [current]: 0 } : {}) });
      if (j.build) { if (build.current === null) build.current = j.build; else if (j.build !== build.current) setStale(true); }
    } catch {
      /* offline: keep the last counts */
    }
  }, [current]);

  // An update came out while the page was open: the next tab you open loads in full, with the new version.
  const firstPath = useRef(path);
  useEffect(() => { if (stale && path !== firstPath.current) window.location.reload(); firstPath.current = path; }, [path, stale]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => { if (document.visibilityState === "visible") void poll(); }, POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [poll]);

  return (
    <nav>
      <Link href="/" className="brand" aria-label="Scout home"><img src="/icon.svg" alt="" width={22} height={22} className="brand-logo" /> Scout</Link>
      {stale && <button type="button" className="chip nav-update" onClick={() => window.location.reload()} title="The site was updated since this page was opened">Updated · reload</button>}
      {LINKS.map((l) => {
        // A tab's count is its own page's plus its other pages', less the page that is open now.
        const c = [l.badge, ...(l.also ?? [])].filter((t): t is string => !!t && t !== current).reduce((a, t) => a + (counts[t] ?? 0), 0);
        return (
          <Link key={l.href} href={l.href} className={`nav-link${l.href === active ? " active" : ""}`} aria-current={l.href === active ? "page" : undefined}>
            {l.label}
            {c > 0 && <span className="nav-badge" title={`${c >= 100 ? "100+" : c} new since you last looked`}>{c >= 100 ? "99+" : c}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
