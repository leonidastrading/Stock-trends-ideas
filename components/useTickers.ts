"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { notTickers } from "@/lib/scout/acronyms";

/**
 * Tickers in AI replies: which capitalised words are real listed symbols (coloured, linked to TradingView) and
 * which have a scout card (linked to the newest one). Starts from what the page already knows; asks the server
 * about new words as replies arrive.
 */
export function useTickers(texts: string[], initialKnown: string[] = [], initialCards: Record<string, number> = {}, context: string[] = []) {
  const [known, setKnown] = useState(() => new Set(initialKnown));
  const [names, setNames] = useState<Record<string, string>>({});
  const [cards, setCards] = useState(() => new Map(Object.entries(initialCards)));
  const asked = useRef(new Set<string>());
  const joined = texts.join("\n");
  useEffect(() => {
    const words = [...new Set(joined.match(/\b[A-Z]{2,5}(?:\.[A-Z])?\b/g) ?? [])].filter((w) => !asked.current.has(w)).slice(0, 80);
    if (!words.length) return;
    for (const w of words) asked.current.add(w);
    fetch(`/api/lookup?listed=${encodeURIComponent(words.join(","))}`).then((r) => r.json()).then((j: { listed?: string[]; cards?: Record<string, number>; names?: Record<string, string> }) => {
      if (j.listed?.length) setKnown((k) => new Set([...k, ...j.listed!]));
      if (j.names && Object.keys(j.names).length) setNames((n) => ({ ...n, ...j.names }));
      if (j.cards && Object.keys(j.cards).length) setCards((c) => new Map([...c, ...Object.entries(j.cards!)]));
    }).catch(() => undefined);
  }, [joined]);
  // A word spelled out as something other than the listed company ("Intelligent Agreement Management (IAM)") is not a ticker.
  const ctx = context.join("\n");
  const shown = useMemo(() => {
    const drop = notTickers([joined, ctx], names, initialKnown);
    if (!drop.size) return { known, cards };
    return { known: new Set([...known].filter((w) => !drop.has(w))), cards: new Map([...cards].filter(([w]) => !drop.has(w))) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, cards, names, joined, ctx]);
  return shown;
}
