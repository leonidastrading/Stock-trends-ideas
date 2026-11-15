"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

const KEY = (path: string) => `scout-filters:${path}`;

/**
 * Remembers a page's filter choices (days, sort, status, source…) in this browser and puts them back when the page
 * is opened plain, from the menu. A link that carries its own settings (a card link, a filter you just picked) wins,
 * and picking the defaults is remembered too (those links carry ?all=1).
 */
export default function RememberFilters({ keys }: { keys: string[] }) {
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    try {
      if ([...sp.keys()].length === 0) {
        const saved = localStorage.getItem(KEY(path));
        if (saved) router.replace(`${path}?${saved}${location.hash}`);
        return;
      }
      if (sp.has("card")) return; // opened from a card link: do not change the saved filters
      const keep = new URLSearchParams();
      for (const k of keys) { const v = sp.get(k); if (v) keep.set(k, v); }
      localStorage.setItem(KEY(path), keep.toString());
    } catch {
      /* storage unavailable */
    }
  }, [path, keys, router]);
  return null;
}
