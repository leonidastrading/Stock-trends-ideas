"use client";

import { useState } from "react";

/** A read-only block of text with a copy button. */
export default function CopyBox({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      <button
        className="primary"
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
        {done ? "Copied" : label}
      </button>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8, maxHeight: 420, overflow: "auto", padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>{text}</pre>
    </div>
  );
}
