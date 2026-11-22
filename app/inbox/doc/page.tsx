import { notFound } from "next/navigation";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import { findQuote } from "@/lib/scout/themes";
import { fmtEtAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One document from the inbox, as the scout read it, with the quoted passage highlighted. /inbox/doc?path=…&q=… */
export default async function InboxDocPage({ searchParams }: { searchParams: Promise<{ path?: string; q?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const { path = "", q = "" } = await searchParams;
  if (!path) notFound();
  const doc = await store.inboxDoc(path);
  if (!doc) notFound();
  const text = doc.text ?? "";
  const hit = q ? findQuote(text, q) : null;
  return (
    <>
      <p className="small"><a href="/inbox">← Inbox</a> · <a href="/themes">Themes</a></p>
      <h1 style={{ wordBreak: "break-all" }}>{path.split("/").pop()}</h1>
      <p className="small muted">Received {fmtEtAgo(doc.readAt)} · the text as the scout read it{q ? (hit ? " · the quoted passage is highlighted" : " · the quote is a paraphrase; it was not found word for word") : ""}</p>
      <section className="card">
        {text ? (
          <div className="small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {hit ? <>{text.slice(0, hit.start)}<mark id="quote">{text.slice(hit.start, hit.end)}</mark>{text.slice(hit.end)}</> : text}
          </div>
        ) : <p className="small muted">No text was kept for this document.</p>}
      </section>
    </>
  );
}
