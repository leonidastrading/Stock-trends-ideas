import { describe, expect, it } from "vitest";
import { isEnglishHeadline, linkLanguage } from "@/lib/language";

describe("translations of a press release", () => {
  it("are told from the English one by the wire's link", () => {
    expect(linkLanguage("https://www.globenewswire.com/news-release/2026/11/27/3190000/0/fr/MISE-A-JOUR-YYForce.html")).toBe("fr");
    expect(linkLanguage("https://www.globenewswire.com/news-release/2026/11/27/3190000/0/en/UPDATE-YYForce.html")).toBe("en");
    expect(linkLanguage("https://www.prnewswire.com/news-releases/x-302000.html")).toBeNull();
    expect(isEnglishHeadline("Whatever it says", "https://www.globenewswire.com/news-release/2026/11/27/3190000/0/de/x.html")).toBe(false);
  });
  it("are told by their script or their small words when the link does not say", () => {
    expect(isEnglishHeadline("更新： YYForce (NASDAQ: YFOR) 採用 NVIDIA Jetson 及 Isaac Sim，推出經過訓練、可提供酒店禮賓服務的人形機器人")).toBe(false);
    expect(isEnglishHeadline("MISE À JOUR : YYForce (NASDAQ : YFOR) lance un robot humanoïde entraîné pour assurer un service de conciergerie hôtelière grâce aux technologies NVIDIA")).toBe(false);
    expect(isEnglishHeadline("UPDATE: YYForce (NASDAQ: YFOR) bringt einen trainierten humanoiden Roboter für den Hotel-Concierge-Service auf den Markt")).toBe(false);
    expect(isEnglishHeadline("YYForce (NASDAQ: YFOR) lanza un robot humanoide para el servicio de conserjería con tecnología de NVIDIA")).toBe(false);
  });
  it("keep English headlines, including ones with foreign names in them", () => {
    expect(isEnglishHeadline("UPDATE: YYForce (NASDAQ: YFOR) Launches a Trained Humanoid Robot for Hotel Concierge Service")).toBe(true);
    expect(isEnglishHeadline("Nestlé and L'Oréal extend their partnership with Société Générale")).toBe(true);
    expect(isEnglishHeadline("Banco Santander Brasil S.A. reports third quarter results")).toBe(true);
    expect(isEnglishHeadline("La-Z-Boy raises its dividend")).toBe(true);
    expect(isEnglishHeadline("AAPL")).toBe(true);
    expect(isEnglishHeadline("Trading halted: XYZ (news pending)")).toBe(true);
  });
});
