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
          <Link href="/">Home</Link>
          <Link href="/ideas">Ideas</Link>
          <Link href="/news">News</Link>
          <Link href="/map">Map</Link>
          <Link href="/chat">Chat</Link>
          <Link href="/notice">I noticed something</Link>
          <Link href="/inbox">Inbox</Link>
          <Link href="/filings">Filings</Link>
          <Link href="/congress">Congress</Link>
          <Link href="/watchlist">Watch-list</Link>
          <Link href="/scoreboard">Scoreboard</Link>
          <Link href="/scoring">Scoring</Link>
          <Link href="/chatter">Chatter test</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
