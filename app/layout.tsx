import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trend scout",
  description: "Paper-only research assistant: real-world changes the market has not priced, written up as thesis cards and scored against SPY.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <span className="brand">Trend scout</span>
          <Link href="/digest">Digest</Link>
          <Link href="/stories">Stories</Link>
          <Link href="/notice">I noticed something</Link>
          <Link href="/candidates">Candidates</Link>
          <Link href="/watchlist">Watch-list</Link>
          <Link href="/scoring">Scoring</Link>
          <Link href="/settings">Settings</Link>
          <span className="shadow">Paper only · suggests and records · never places an order</span>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
