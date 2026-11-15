import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Merged into the Ideas tab; old links (phone alerts, emails, bookmarks) still land there, with their card anchor. */
export default async function Moved({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const k of ["days", "card"]) if (sp[k]) q.set(k, sp[k]!);
  redirect(`/ideas${q.size ? `?${q}` : ""}`);
}
