"use client";

import { useState } from "react";

/** A table row that opens a full-width panel below it when clicked (the panel is only rendered once opened). */
export default function ExpandRow({ cells, panel, cols, title }: { cells: React.ReactNode; panel: React.ReactNode; cols: number; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="expand-row" onClick={(e) => { if ((e.target as HTMLElement).closest("a,button,input")) return; setOpen(!open); }} title={title} style={{ cursor: "pointer" }} aria-expanded={open}>
        {cells}
      </tr>
      {open && <tr className="expand-panel"><td colSpan={cols}>{panel}</td></tr>}
    </>
  );
}
