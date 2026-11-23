/**
 * "New since you last looked", kept in the browser: when each item was first shown to you. An item counts as new
 * from the moment it first appears until a few minutes later, so the flag survives a reload in the same sitting.
 * Pure (no storage here): the component reads and writes localStorage.
 */
export const SEEN = { graceMin: 15, keepDays: 4 };

/** Pure: record the items shown now and say which are new (first shown within the grace period). */
export function markSeen(prev: Record<string, number>, keys: string[], now: number, graceMin = SEEN.graceMin, keepDays = SEEN.keepDays): { next: Record<string, number>; fresh: string[] } {
  const next: Record<string, number> = {};
  const shown = new Set(keys);
  // Forget what left the list long ago; what is still listed is always remembered.
  for (const [k, t] of Object.entries(prev)) if (typeof t === "number" && (shown.has(k) || now - t <= keepDays * 86400_000)) next[k] = t;
  for (const k of keys) if (!(k in next)) next[k] = now;
  return { next, fresh: keys.filter((k) => now - next[k] < graceMin * 60_000) };
}
