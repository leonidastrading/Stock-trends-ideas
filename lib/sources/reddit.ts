/**
 * Reddit: posts mentioning the term in the finance subreddits (title or text), last 7 days vs the weekly average of
 * the 4 weeks before, from the scout's own copy of Reddit (read through Arctic Shift; see arctic.ts). The 12-month
 * base comes from the scout's stored history once it has one.
 */
import { ARCTIC, coverageDays, mentions } from "./arctic";
import { change, dateStr, guarded, pct, r1, type Source } from "./types";

export const reddit: Source = {
  id: "reddit",
  label: "Reddit",
  about: `Mentions in ${ARCTIC.finance.length} finance subreddits (r/${ARCTIC.finance.slice(0, 3).join(", r/")}…), from the scout's copy of Reddit via the Arctic Shift archive; growth from a low base, not rank.`,
  configured: () => true,
  probe: (ctx) =>
    guarded("reddit", async () => {
      const days = await coverageDays(ctx.now);
      if (days < 7) return { source: "reddit", status: "missing", detail: `collecting posts: ${days} day(s) stored so far, counts start at 7`, signals: [] };
      const now = ctx.now.getTime();
      const week = await mentions(ctx.term, new Date(now - 7 * 86400_000), ctx.now);
      const priorDays = Math.min(28, days - 7);
      const prior = priorDays >= 7 ? await mentions(ctx.term, new Date(now - (7 + priorDays) * 86400_000), new Date(now - 7 * 86400_000)) : null;
      const weeklyBase = prior ? r1(prior.n / (priorDays / 7)) : null;
      const ch = weeklyBase !== null ? change(week.n, weeklyBase) : null;
      return {
        source: "reddit", status: "ok", detail: priorDays < 28 ? `building history: ${days} days stored` : undefined,
        signals: [{
          source: "reddit", metric: "posts_7d", value: week.n, baseline: null, changeVs12m: null, asOf: dateStr(ctx.now),
          note: `${week.n} posts mentioning "${ctx.term}" in ${ARCTIC.finance.length} finance subreddits in 7 days${weeklyBase !== null ? ` vs ${weeklyBase}/week over the ${priorDays} days before (${pct(ch)})` : " (no earlier weeks stored yet)"}`,
          detail: { prior_days: priorDays, weekly_avg_prior: weeklyBase, change_vs_prior: ch, top: week.top },
        }],
      };
    }),
};
