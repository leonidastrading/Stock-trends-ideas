/** What makes a news item a top story: pure, so the News page in the browser and the menu's badge use the same rule. */
import type { FeedItem } from "./newsfeed";

/** Pure: why a story is a top story ("" when it is not): Trump, a rumor already reported, an event, a stock on your cards, a pile-up. */
export const topReason = (i: FeedItem): string => (i.kind === "trump" ? "Trump" : i.kind === "rumor" ? "from rumors" : i.event && i.event !== "paused" ? i.event : i.cardIds.length && i.symbols.length <= 4 ? "on your cards" : i.buzz >= 3 ? `${i.buzz} stories` : "");

/** Pure: a top story: a reason to be top, a fresh score of at least 1 (stocks under $5 fall below), not a re-post. */
export const isTopStory = (i: FeedItem): boolean => !i.repostedAt && i.score >= 1 && topReason(i) !== "";
