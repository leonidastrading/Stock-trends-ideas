"use client";

import { useEffect, useState } from "react";

/** The card's PDF download. The financials in it follow the Annual / Quarterly choice made on the cards (quarterly when none was made). */
export default function CardPdfLink({ cardId }: { cardId: number }) {
  const [period, setPeriod] = useState<"quarter" | "annual">("quarter");
  useEffect(() => {
    const read = () => { try { setPeriod(JSON.parse(localStorage.getItem("scout:fundamentals-period") ?? '"quarter"') === "annual" ? "annual" : "quarter"); } catch { /* storage unavailable: quarterly */ } };
    read();
    // The choice may be changed on a card after this one was drawn: read it again when the button is about to be used.
    window.addEventListener("pointerdown", read, true);
    return () => window.removeEventListener("pointerdown", read, true);
  }, []);
  return <a className="chip card-pdf-btn" href={`/api/card-pdf/${cardId}${period === "annual" ? "?period=annual" : ""}`} download title={`Download this card as a PDF (financials ${period === "annual" ? "by year" : "by quarter"})`}>PDF ↓</a>;
}
