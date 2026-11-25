"use client";

import { useEffect, useState } from "react";
import { isNewSince, PREV_KEY } from "@/lib/last-visit";

/** A red NEW on a row that appeared since you last opened this tab (the same count the menu showed). */
export default function NewSince({ tab, at }: { tab: string; at: string | null | undefined }) {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const read = () => { try { setFresh(isNewSince(JSON.parse(localStorage.getItem(PREV_KEY) ?? "{}"), tab, at)); } catch { /* no storage: no flag */ } };
    read();
    // The menu records the visit as the page opens: read again once it has.
    window.addEventListener("scout-visit", read);
    return () => window.removeEventListener("scout-visit", read);
  }, [tab, at]);
  return fresh ? <span className="new-flag" style={{ marginLeft: 6 }} title="New since you last opened this tab">NEW</span> : null;
}
