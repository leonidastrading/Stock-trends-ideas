/** The idea map's sources (shared by the server builder and the client map). */
export const MAP_SOURCES = [
  { key: "trend", label: "Trend desk", color: "#60a5fa" }, { key: "story", label: "Story desk", color: "#f472b6" },
  { key: "news", label: "News", color: "#e5e7eb" }, { key: "stocktwits", label: "Stocktwits", color: "#38bdf8" },
  { key: "insider", label: "Insider buys", color: "#a78bfa" }, { key: "congress", label: "Congress", color: "#818cf8" },
  { key: "filings", label: "8-K / 13D", color: "#c084fc" }, { key: "options", label: "Options flow", color: "#facc15" },
  { key: "contracts", label: "Gov contracts", color: "#34d399" }, { key: "earnings", label: "Earnings soon", color: "#fb923c" },
  { key: "movers", label: "Big movers", color: "#f87171" }, { key: "truth", label: "Trump posts", color: "#fbbf24" },
  { key: "inbox", label: "Your bot", color: "#2dd4bf" }, { key: "you", label: "You", color: "#4ade80" },
] as const;
export type MapSourceKey = (typeof MAP_SOURCES)[number]["key"];
