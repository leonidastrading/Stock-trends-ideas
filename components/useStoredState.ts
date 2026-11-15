"use client";

import { useEffect, useRef, useState } from "react";

/** useState that this browser remembers (a page's view or filter). Starts from `initial` and switches to the saved value after load. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const s = localStorage.getItem(`scout:${key}`);
      if (s !== null) setV(JSON.parse(s) as T);
    } catch {
      /* storage unavailable or old value */
    }
    loaded.current = true;
  }, [key]);
  const set = (next: T) => {
    setV(next);
    try { localStorage.setItem(`scout:${key}`, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  return [v, set];
}
