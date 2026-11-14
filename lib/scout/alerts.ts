/** What gets pushed to the phone, once each: new promoted cards, new story trades, catalyst reviews, failed jobs. */
import { pushConfigured, sendPush, type Push } from "../notify";
import * as store from "./store";
import type { StoredCard } from "./store";

const arrow = (d: "long" | "short") => (d === "long" ? "▲" : "▼");
const VERDICT: Record<string, { label: string; tag: string }> = {
  played_out: { label: "played out", tag: "white_check_mark" },
  did_not: { label: "did not play out", tag: "x" },
  mixed: { label: "mixed", tag: "grey_question" },
  too_early: { label: "too early to tell", tag: "hourglass" },
};

export function cardLink(env: NodeJS.ProcessEnv, id: number): string | undefined {
  return env.DASHBOARD_URL ? `${env.DASHBOARD_URL.replace(/\/$/, "")}/candidates?days=30#card-${id}` : undefined;
}

/** Pure: the pushes for a set of new cards; more than three are bundled into one. */
export function cardPushes(cards: Array<StoredCard & { story: boolean }>, env: NodeJS.ProcessEnv): Push[] {
  if (cards.length > 3) {
    return [{
      title: `Trend scout: ${cards.length} new trade cards`,
      message: cards.map((c) => `${arrow(c.direction)} ${c.primaryTicker} (${c.story ? "story" : c.status}) ${c.card.title}`).join("\n"),
      tags: ["newspaper"],
      click: env.DASHBOARD_URL ? `${env.DASHBOARD_URL.replace(/\/$/, "")}/candidates` : undefined,
    }];
  }
  return cards.map((c) => ({
    title: `${arrow(c.direction)} ${c.primaryTicker} · ${c.story ? "story trade" : c.status}${c.status === "late" ? " (late)" : ""}`,
    message: `${c.card.title}\n${c.card.why_not_priced.slice(0, 280)}${c.card.catalyst.date !== "unknown" ? `\nCatalyst ${c.card.catalyst.date}: ${c.card.catalyst.what.slice(0, 120)}` : ""}`,
    tags: [c.direction === "long" ? "chart_with_upwards_trend" : "chart_with_downwards_trend"],
    click: cardLink(env, c.id),
    priority: c.status === "promoted" ? 4 : 3,
  }));
}

/** Push cards created in the last two days that the settings ask for and that were not pushed yet. */
export async function pushNewCards(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<number> {
  if (!pushConfigured(env)) return 0;
  const settings = await store.loadSettings();
  const [cards, candidates] = await Promise.all([store.cardsSince(2), store.candidatesSince(2)]);
  const termBy = new Map(candidates.filter((c) => c.cardId).map((c) => [c.cardId!, c.term]));
  const wanted = cards
    .map((c) => ({ ...c, story: (termBy.get(c.id) ?? "").startsWith("story:") }))
    .filter((c) => c.origin === "scout" && ((settings.notifyPromoted && c.status === "promoted") || (settings.notifyStories && c.story && c.status !== "not_promoted")));
  const fresh: typeof wanted = [];
  for (const c of wanted.reverse()) if (await store.claimNotification(`card:${c.id}`, c.card.title)) fresh.push(c);
  for (const p of cardPushes(fresh, env)) await sendPush(p, env, fetchImpl);
  return fresh.length;
}

export async function pushReviews(reviews: Array<{ cardId: number; verdict?: string }>, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<number> {
  if (!pushConfigured(env) || !(await store.loadSettings()).notifyReviews) return 0;
  let n = 0;
  for (const r of reviews) {
    if (!r.verdict) continue;
    const [card, review] = await Promise.all([store.getCard(r.cardId), store.getReview(r.cardId)]);
    if (!card || !review || !(await store.claimNotification(`review:${r.cardId}`, card.card.title))) continue;
    const v = VERDICT[review.verdict] ?? { label: review.verdict, tag: "grey_question" };
    await sendPush({
      title: `${arrow(card.direction)} ${card.primaryTicker} after the catalyst: ${v.label}`,
      message: `${review.summary}${review.moveSinceEntryPct !== null ? `\nTrade since entry: ${review.moveSinceEntryPct >= 0 ? "+" : ""}${review.moveSinceEntryPct}%` : ""}`,
      tags: [v.tag],
      click: cardLink(env, card.id),
    }, env, fetchImpl);
    n++;
  }
  return n;
}

/** Best effort: a failed job tells the phone, once per job per day. */
export async function pushFailure(job: string, message: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!pushConfigured(env)) return;
  const key = `fail:${job}:${new Date().toISOString().slice(0, 10)}`;
  try {
    if (await store.claimNotification(key, message.slice(0, 200))) await sendPush({ title: `Trend scout: ${job} job failed`, message: message.slice(0, 500), tags: ["warning"], priority: 4 }, env);
  } catch {
    /* never let alerting break a job */
  }
}
