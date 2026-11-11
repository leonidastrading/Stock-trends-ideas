/** Stocktwits message volume by ticker: no data source is wired yet, so it is marked missing (adding one starts a new version). */
import type { Source } from "./types";

export const stocktwits: Source = {
  id: "stocktwits",
  label: "Stocktwits",
  about: "Message volume by ticker. MISSING: no server-side data source yet.",
  configured: () => false,
  probe: async () => ({ source: "stocktwits", status: "missing", detail: "no data source configured", signals: [] }),
};
