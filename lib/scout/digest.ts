/** The weekly digest: the top promoted cards of the week, ranked by novelty × materiality, lateness shown. Pure builder + the Monday send. */
import { KIND_LABEL, SCOUT, type Kind } from "@/config/scout";
import { emailConfigured, sendEmail } from "../email";
import { isoWeek, toEt } from "../time";
import * as store from "./store";
import type { StoredCard } from "./store";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Pure: pick the week's top cards. Promoted first; late cards fill in only if asked. */
export function digestCards(cards: StoredCard[], n = SCOUT.digestCards): StoredCard[] {
  return cards.filter((c) => c.status === "promoted").sort((a, b) => b.rankScore - a.rankScore || b.createdAt.localeCompare(a.createdAt)).slice(0, n);
}

export function buildDigestEmail(cards: StoredCard[], weekKey: string, dashboardUrl: string | undefined): { subject: string; html: string; text: string } {
  const subject = `Trend scout ${weekKey}: ${cards.length} promoted idea${cards.length === 1 ? "" : "s"}`;
  const rows = cards.map((c) => {
    const k = c.card;
    const late = `${k.lateness.stock_move_30d_pct >= 0 ? "+" : ""}${k.lateness.stock_move_30d_pct.toFixed(1)}% / 30d, ${k.lateness.news_stories_30d} stories`;
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top"><b>${esc(k.title)}</b><br><span style="color:#555;font-size:12px">${esc(KIND_LABEL[c.kind as Kind] ?? c.kind)} · ${c.origin} · ${c.direction} ${esc(c.primaryTicker)} · novelty ${k.scores.novelty} × materiality ${k.scores.materiality} = ${c.rankScore}</span><br><span style="font-size:13px">${esc(k.observation)}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap;font-size:12px">${esc(late)}</td></tr>`;
  }).join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;max-width:680px">
<p style="color:#555;font-size:12px;margin:0 0 8px">PAPER ONLY — the scout suggests and records; it never places an order.</p>
<p>Top promoted cards this week, ranked by novelty × materiality. Lateness = primary ticker's 30-day move and mainstream stories in 30 days.</p>
<table style="border-collapse:collapse;width:100%"><thead><tr><th style="text-align:left;padding:6px 8px;font-size:12px;color:#555">Card</th><th style="text-align:left;padding:6px 8px;font-size:12px;color:#555">Lateness</th></tr></thead><tbody>${rows || `<tr><td colspan="2" style="padding:8px;color:#777">No promoted cards this week.</td></tr>`}</tbody></table>
${dashboardUrl ? `<p style="font-size:12px"><a href="${esc(dashboardUrl)}/digest">Open the digest</a> to send a card to the Swing ideas log.</p>` : ""}
</div>`;
  const text = [`Trend scout ${weekKey} (paper only)`, ...cards.map((c) => `- ${c.card.title} [${c.kind}, ${c.origin}, ${c.direction} ${c.primaryTicker}] rank ${c.rankScore}; lateness ${c.card.lateness.stock_move_30d_pct.toFixed(1)}% / ${c.card.lateness.news_stories_30d} stories`)].join("\n");
  return { subject, html, text };
}

/** Send the digest once per ISO week, on Mondays. Returns what happened. */
export async function maybeSendDigest(now: Date, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const et = toEt(now);
  if (et.weekday !== 1) return "not Monday";
  const settings = await store.loadSettings();
  if (!settings.emailDigest) return "digest email off in Settings";
  if (!emailConfigured(env)) return "email not configured";
  const week = isoWeek(et.date);
  const cards = digestCards(await store.cardsSince(7));
  const mail = buildDigestEmail(cards, week, env.DASHBOARD_URL);
  if (!(await store.claimEmail(`digest-${week}`, mail.subject))) return `already sent for ${week}`;
  try {
    await sendEmail(mail, env);
    return `sent for ${week} (${cards.length} cards)`;
  } catch (err) {
    await store.releaseEmail(`digest-${week}`);
    throw err;
  }
}
