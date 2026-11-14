"use client";

import { useState } from "react";

/** One line of text in a small box, with a copy button beside it. */
export default function CopyLine({ label, text }: { label: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small secondary" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <code style={{ flex: 1, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13 }}>{text}</code>
        <button
          className="primary"
          style={{ flexShrink: 0 }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setDone(true);
              setTimeout(() => setDone(false), 2000);
            } catch {
              setDone(false);
            }
          }}
        >
          {done ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
