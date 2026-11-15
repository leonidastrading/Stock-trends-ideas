"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tickers in AI replies: which capitalised words are real listed symbols (coloured, linked to TradingView) and
 * which have a scout card (linked to the newest one). Starts from what the page already knows; asks the server
 * about new words as replies arrive.
 */
export function useTickers(texts: string[], initialKnown: string[] = [], initialCards: Record<string, number> = {}) {
  const [known, setKnown] = useState(() => new Set(initialKnown));
  const [cards, setCards] = useState(() => new Map(Object.entries(initialCards)));
  const asked = useRef(new Set<string>());
  const joined = texts.join("\n");
  useEffect(() => {
    const words = [...new Set(joined.match(/\b[A-Z]{2,5}(?:\.[A-Z])?\b/g) ?? [])].filter((w) => !asked.current.has(w)).slice(0, 80);
    if (!words.length) return;
    for (const w of words) asked.current.add(w);
    fetch(`/api/lookup?listed=${encodeURIComponent(words.join(","))}`).then((r) => r.json()).then((j: { listed?: string[]; cards?: Record<string, number> }) => {
      if (j.listed?.length) setKnown((k) => new Set([...k, ...j.listed!]));
      if (j.cards && Object.keys(j.cards).length) setCards((c) => new Map([...c, ...Object.entries(j.cards!)]));
    }).catch(() => undefined);
  }, [joined]);
  return { known, cards };
}
