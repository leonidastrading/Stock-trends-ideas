"use client";

import { useState } from "react";

/** A star on each card: tap to add it to Favorites (saved on the server, so it shows on every device), tap again to remove. */
export default function FavoriteStar({ cardId, initial }: { cardId: number; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    const next = !on;
    setOn(next); // at once; put back if the save fails
    setBusy(true);
    const res = await fetch("/api/favorites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId, on: next }) }).catch(() => null);
    setBusy(false);
    if (!res?.ok) setOn(!next);
  }
  return (
    <button type="button" className={`fav-star${on ? " on" : ""}`} onClick={toggle} disabled={busy} aria-pressed={on} title={on ? "In Favorites: tap to remove" : "Add to Favorites"} aria-label={on ? `Remove card #${cardId} from Favorites` : `Add card #${cardId} to Favorites`}>
      {on ? "★" : "☆"}
    </button>
  );
}
