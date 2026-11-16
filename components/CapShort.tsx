import { capBucket, fmtCap, stockProfile } from "@/lib/market/profile";

const shares = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/** Market cap and short interest beside the price on a card (streams in; never holds up the card). */
export default async function CapShort({ symbol, price }: { symbol: string; price: number | null }) {
  const p = await stockProfile(symbol, price).catch(() => null);
  if (!p) return null;
  const cap = fmtCap(p.marketCap);
  const s = p.short;
  if (!cap && !(s && s.interest !== null)) return null;
  const pct = s?.pctFloat ?? s?.pctOutstanding ?? null;
  const tip = s ? `Short interest${s.interest !== null ? `: ${s.interest.toLocaleString("en-US")} shares` : ""}${s.asOf ? `, settled ${s.asOf}` : ""}${s.changePct !== null ? `, ${s.changePct > 0 ? "+" : ""}${s.changePct}% vs the prior report` : ""}. Source: ${s.source}. Exchanges publish it twice a month, so it lags by about two weeks.` : "";
  return (
    <span className="cap-short">
      {cap && <span className="cap-chip" title={`Market cap${p.capSource ? ` (${p.capSource})` : ""}`}>{cap} <span className="muted">{capBucket(p.marketCap)}</span></span>}
      {s && s.interest !== null && (
        <span className={`cap-chip${s.squeeze === "high" ? " neg" : s.squeeze === "elevated" ? " warn" : ""}`} title={tip}>
          short {pct !== null ? <><b>{pct}%</b><span className="cap-long">{s.pctFloat != null ? " of float" : " of shares"}</span></> : `${shares(s.interest)} sh`}
          {s.daysToCover !== null ? <> · {s.daysToCover}d<span className="cap-long"> to cover</span></> : ""}
          {s.squeeze && s.squeeze !== "normal" ? <> · squeeze<span className="cap-long"> risk</span> {s.squeeze}</> : ""}
        </span>
      )}
    </span>
  );
}
