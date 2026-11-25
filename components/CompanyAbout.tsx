import { background } from "@/lib/background";
import { companyAbout, fillCompanyAbout, isStale } from "@/lib/scout/company-line";

const SECTOR_LABEL: Record<string, string> = { technology: "Technology", communication: "Communication services", consumer_discretionary: "Consumer discretionary", consumer_staples: "Consumer staples", health_care: "Health care", financials: "Financials", industrials: "Industrials", energy: "Energy", materials: "Materials", utilities: "Utilities", real_estate: "Real estate" };

/** Under a card's company name: what the company does (its Wikipedia article's opening), its sector and the SEC's industry. */
export default async function CompanyAbout({ symbol, sector }: { symbol: string; sector: string }) {
  let a = await companyAbout(symbol);
  if (isStale(a, new Date())) {
    // Looked up once per stock: waited for briefly, finished after the page is sent if it takes longer.
    const filling = fillCompanyAbout(symbol).catch(() => null);
    background(async () => { await filling; });
    a = (await Promise.race([filling, new Promise<null>((r) => setTimeout(() => r(null), 2500))])) ?? a;
  }
  const label = SECTOR_LABEL[sector] ?? sector.replace(/_/g, " ");
  return (
    <div className="small secondary" style={{ margin: "2px 0 4px" }}>
      {a?.about ? <><b>What it does:</b> {a.about}{a.article ? <> <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(a.article.replace(/ /g, "_"))}`} target="_blank" rel="noreferrer" className="muted">Wikipedia</a></> : null} · </> : null}
      <b>Sector:</b> {label}{a?.industry ? <> · <span title="The industry the SEC files this company under">{a.industry}</span></> : null}
    </div>
  );
}
