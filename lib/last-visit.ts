/**
 * "New since you last looked", per menu tab, kept in the browser. The menu records when each tab was last open;
 * opening a tab again would overwrite that at once, so the moment before it is kept as the "previous visit" and rows
 * newer than it are flagged. A reload or a few minutes on the page is the same visit; coming back later is a new one.
 * Pure (no storage here): the menu and the flag read and write localStorage.
 */
export const VISIT = { sameVisitMin: 3 };
export const SEEN_KEY = "scout-seen";
export const PREV_KEY = "scout-prev";

/**
 * Pure: on opening `tab` at `now`, the new "last seen" and "previous visit" records. The previous visit moves forward
 * only when the tab had been closed for a while, so the flags stay through a reload.
 */
export function openTab(seen: Record<string, string>, prev: Record<string, string>, tab: string, now: string, sameVisitMin = VISIT.sameVisitMin): { seen: Record<string, string>; prev: Record<string, string> } {
  const last = seen[tab];
  const away = last ? Date.parse(now) - Date.parse(last) > sameVisitMin * 60_000 : false;
  return { seen: { ...seen, [tab]: now }, prev: away ? { ...prev, [tab]: last } : prev };
}

/** Pure: whether an item that appeared at `at` is new since the previous visit to its tab (never on a first visit). */
export function isNewSince(prev: Record<string, string>, tab: string, at: string | null | undefined): boolean {
  const before = prev[tab];
  return !!before && !!at && Date.parse(at) > Date.parse(before);
}
