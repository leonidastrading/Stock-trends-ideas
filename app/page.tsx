import ActivityLog, { OUTCOMES } from "@/components/desk/ActivityLog";
import StoryDesk from "@/components/desk/StoryDesk";
import TrendScan from "@/components/desk/TrendScan";
import Direction from "@/components/Direction";
import MarketPanels from "@/components/MarketPanels";
import { FilterLinks } from "@/components/Pager";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { upcomingCatalysts } from "@/lib/scout/calendar";
import * as store from "@/lib/scout/store";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cardLink = (id: number) => `/ideas?days=90&card=${id}#card-${id}`;

/** Home: the market at a glance, what is coming up on open paper tracks, and what the desks did. The cards live on Ideas. */
export default async function Home({ searchParams }: { searchParams: Promise<{ days?: string; lo?: string; lpage?: string; spage?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const lo = OUTCOMES.some((o) => o.value === sp.lo) ? sp.lo! : "";
  const params: Record<string, string | undefined> = { days: days === 7 ? undefined : String(days), lo: lo || undefined, lpage: sp.lpage, spage: sp.spage };
  const [candidates, cards, tracks, recent, health, runs, fb] = await Promise.all([
    store.candidatesSince(days), store.cardsSince(days), store.allTracks(), store.cardsSince(120), store.allHealth(), store.recentRuns(30), store.latestFeedback(),
  ]);
  const coming = upcomingCatalysts(recent, tracks, toEt(new Date()).date);
  const down = health.filter((h) => h.status === "down" || h.status === "missing");
  const lastDaily = runs.find((r) => r.action === "daily" && r.status !== "running");
  const running = runs.find((r) => r.action === "daily" && r.status === "running");
  return (
    <>
      <h1>Home</h1>
      {down.length > 0 && <p className="small warn">Sources not reporting: {down.map((h) => `${h.source} (${h.status})`).join(", ")}. See Settings.</p>}
      {running && <p className="small warn">A scan started at {running.startedAt.replace("T", " ").slice(0, 16)}Z is still running; refresh in a few minutes.</p>}

      <MarketPanels />

      {coming.length > 0 && (
        <details className="card section" open>
          <summary><h2>Coming up: dated catalysts on open paper tracks (next 3 weeks)</h2> <span className="small muted">{coming.length}</span></summary>
          <div className="table-wrap"><table><tbody>
            {coming.map((u) => (
              <tr key={u.cardId}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{u.date}</td>
                <td><Direction direction={u.direction} ticker={u.ticker} size="small" /></td>
                <td className="small">{u.what} <span className="muted">— <a href={cardLink(u.cardId)}>#{u.cardId}</a> {u.title}</span></td>
              </tr>
            ))}
          </tbody></table></div>
        </details>
      )}

      <h2 style={{ marginTop: 20 }}>Desk reports</h2>
      <div className="toolbar">
        <span className="small muted">Activity window:</span>
        <FilterLinks params={params} name="days" value={days === 7 ? "" : String(days)} reset={["lpage"]} options={[{ value: "", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
      </div>
      <ActivityLog candidates={candidates} cards={cards} params={params} outcome={lo} lpage={Number(sp.lpage ?? 1)} cardHref={cardLink} />
      <StoryDesk runs={runs} fb={fb} params={params} spage={Number(sp.spage ?? 1)} />
      {lastDaily && <TrendScan run={lastDaily} />}
    </>
  );
}
