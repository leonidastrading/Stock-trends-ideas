"use client";

import { useState } from "react";

/**
 * Pure: a logo's tone from its RGBA pixels: "mono-light" (white or near-white, like Zoom's), "mono-dark" (black or
 * near-black) or "color". Only plain one-tone logos are flipped on a background of the same tone; colored ones are
 * left as they are.
 */
export function logoTone(px: Uint8ClampedArray): "mono-light" | "mono-dark" | "color" {
  let n = 0, lum = 0, sat = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 48) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    lum += 0.2126 * r + 0.7152 * g + 0.0722 * b; sat += mx === 0 ? 0 : (mx - mn) / mx; n++;
  }
  if (n < 20) return "color";
  lum /= n; sat /= n;
  if (sat > 0.18) return "color";
  return lum > 0.75 ? "mono-light" : lum < 0.3 ? "mono-dark" : "color";
}

/** A company's logo (Financial Modeling Prep's public image), or its ticker in a tile when there is none. */
export default function CompanyLogo({ symbol, name }: { symbol: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const [tone, setTone] = useState("color");
  if (failed) return <span className="cal-logo-text" aria-hidden="true">{symbol}</span>;
  return (
    <img
      className={`cal-logo ${tone}`}
      src={`https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`}
      alt={name}
      loading="lazy"
      crossOrigin="anonymous"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        try {
          const img = e.currentTarget, c = document.createElement("canvas");
          c.width = 32; c.height = 32;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, 32, 32);
          setTone(logoTone(ctx.getImageData(0, 0, 32, 32).data));
        } catch { /* unreadable: leave as is */ }
      }}
    />
  );
}
