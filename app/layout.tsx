import type { Metadata } from "next";
import "./globals.css";
import BackToTop from "@/components/BackToTop";
import NavBar from "@/components/NavBar";
import NewsTicker from "@/components/NewsTicker";

export const metadata: Metadata = {
  title: "Trend scout",
  description: "Paper-only research assistant: real-world changes the market has not priced, written up as thesis cards and scored against SPY.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavBar />
        <NewsTicker />
        <main>{children}</main>
        <BackToTop />
      </body>
    </html>
  );
}
