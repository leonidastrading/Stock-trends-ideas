"use client";

import { useState } from "react";

/** A company's logo (Financial Modeling Prep's public image), or its ticker in a tile when there is none. */
export default function CompanyLogo({ symbol, name }: { symbol: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="cal-logo-text" aria-hidden="true">{symbol}</span>;
  return <img className="cal-logo" src={`https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`} alt={name} loading="lazy" onError={() => setFailed(true)} />;
}
