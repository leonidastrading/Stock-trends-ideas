import { after } from "next/server";

/** Run work after the response is sent (Next's after); outside a request (tests, scripts) it is skipped. */
export function background(work: () => Promise<unknown>): void {
  try {
    after(async () => { await work().catch((err) => console.error(`background work failed: ${err instanceof Error ? err.message : String(err)}`)); });
  } catch {
    /* not in a request scope */
  }
}
