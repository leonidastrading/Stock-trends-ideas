/**
 * Stocks per sector for the random-sector baseline: 20 are drawn at random
 * (seeded by card id) for each idea and run over the same dates. Large and
 * mid-cap US names; edit freely, but a change starts a new version.
 */
import type { Sector } from "./scout";

export const UNIVERSE: Record<Sector, string[]> = {
  technology: ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "AMD", "ADBE", "CSCO", "ACN", "INTU", "IBM", "TXN", "QCOM", "NOW", "AMAT", "PANW", "MU", "ADI", "LRCX", "KLAC", "ANET", "SNPS", "CDNS", "CRWD", "MSI", "FTNT", "ADSK", "WDAY", "ROP", "NXPI", "MCHP", "FICO", "IT", "DELL", "HPQ", "GLW", "APH", "TEL", "STX"],
  communication: ["GOOGL", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS", "CHTR", "EA", "TTWO", "WBD", "OMC", "IPG", "LYV", "FOXA", "NWSA", "PARA", "MTCH", "RBLX", "SPOT", "PINS", "SNAP", "TTD", "ROKU", "DASH", "Z", "IAC", "SIRI", "FYBR"],
  consumer_discretionary: ["AMZN", "TSLA", "HD", "MCD", "BKNG", "LOW", "TJX", "NKE", "SBUX", "CMG", "ORLY", "MAR", "GM", "F", "HLT", "AZO", "ROST", "YUM", "DHI", "LEN", "EBAY", "LULU", "TSCO", "ULTA", "DRI", "RCL", "CCL", "EXPE", "APTV", "BBY", "DECK", "POOL", "KMX", "GPC", "NVR", "PHM", "GRMN", "LVS", "WYNN", "MGM"],
  consumer_staples: ["WMT", "PG", "COST", "KO", "PEP", "PM", "MDLZ", "MO", "CL", "TGT", "KMB", "GIS", "SYY", "KDP", "KR", "STZ", "HSY", "ADM", "MNST", "KHC", "CHD", "K", "MKC", "CLX", "DG", "DLTR", "TSN", "CAG", "SJM", "HRL", "CPB", "TAP", "BG", "EL", "WBA", "KVUE", "LW", "BF.B", "CELH", "WMK"],
  health_care: ["LLY", "UNH", "JNJ", "ABBV", "MRK", "TMO", "ABT", "AMGN", "DHR", "ISRG", "PFE", "SYK", "BSX", "VRTX", "MDT", "GILD", "REGN", "ELV", "CI", "BDX", "ZTS", "BMY", "CVS", "HCA", "MCK", "EW", "A", "IDXX", "IQV", "RMD", "DXCM", "HUM", "BIIB", "MTD", "WST", "ZBH", "CNC", "BAX", "COR", "HOLX"],
  financials: ["BRK.B", "JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "SPGI", "AXP", "BLK", "C", "SCHW", "PGR", "MMC", "CB", "ICE", "CME", "PNC", "USB", "AON", "MCO", "TFC", "COF", "AJG", "TRV", "AFL", "MET", "ALL", "AIG", "BK", "PRU", "MSCI", "FIS", "DFS", "HIG", "NDAQ", "STT", "TROW", "HOOD"],
  industrials: ["GE", "CAT", "RTX", "UNP", "HON", "ETN", "DE", "LMT", "UPS", "BA", "ADP", "GD", "WM", "TT", "NOC", "PH", "CSX", "ITW", "MMM", "EMR", "CTAS", "FDX", "NSC", "CARR", "PCAR", "GWW", "JCI", "CPRT", "URI", "PWR", "ODFL", "FAST", "CMI", "AME", "PAYX", "VRSK", "OTIS", "RSG", "HWM", "VRT"],
  energy: ["XOM", "CVX", "COP", "EOG", "SLB", "MPC", "PSX", "WMB", "OKE", "VLO", "KMI", "HES", "OXY", "FANG", "BKR", "HAL", "TRGP", "DVN", "CTRA", "EQT", "APA", "MRO", "TPL", "LNG", "AR", "RRC", "CHRD", "OVV", "PR", "MTDR"],
  materials: ["LIN", "SHW", "APD", "ECL", "FCX", "NEM", "CTVA", "DD", "NUE", "DOW", "VMC", "MLM", "PPG", "IFF", "LYB", "STLD", "ALB", "CF", "BALL", "AVY", "PKG", "IP", "AMCR", "MOS", "CE", "EMN", "FMC", "CLF", "X", "RS"],
  utilities: ["NEE", "SO", "DUK", "CEG", "SRE", "AEP", "D", "VST", "PCG", "EXC", "XEL", "PEG", "ED", "ETR", "WEC", "EIX", "DTE", "PPL", "AWK", "AEE", "FE", "ES", "CMS", "ATO", "CNP", "NRG", "LNT", "NI", "EVRG", "PNW"],
  real_estate: ["PLD", "AMT", "EQIX", "WELL", "SPG", "PSA", "O", "DLR", "CCI", "CBRE", "VICI", "EXR", "AVB", "IRM", "CSGP", "VTR", "SBAC", "EQR", "WY", "INVH", "ESS", "MAA", "ARE", "KIM", "DOC", "UDR", "HST", "CPT", "REG", "BXP"],
};
