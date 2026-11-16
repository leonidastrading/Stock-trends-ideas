/** Which settings are present. Values are never shown anywhere. */
export interface EnvStatus { key: string; set: boolean; required: boolean; group: string }

export function envStatus(env: NodeJS.ProcessEnv = process.env): EnvStatus[] {
  const row = (key: string, required: boolean, group: string): EnvStatus => ({ key, set: !!env[key], required, group });
  return [
    row("DATABASE_URL", true, "database"),
    row("DASHBOARD_USER", true, "dashboard login"),
    row("DASHBOARD_PASSWORD", true, "dashboard login"),
    row("CRON_SECRET", true, "cron"),
    row("ANTHROPIC_API_KEY", true, "model"),
    row("ALPACA_API_KEY_ID", true, "prices and news (read-only)"),
    row("ALPACA_API_SECRET_KEY", true, "prices and news (read-only)"),
    row("SEC_USER_AGENT", false, "EDGAR"),
    row("GITHUB_INBOX_REPO", false, "GitHub inbox (owner/name)"),
    row("GITHUB_INBOX_TOKEN", false, "GitHub inbox token (read-only Contents)"),
    row("EDGAR_PROXY_URL", false, "EDGAR relay (relay/ on Railway)"),
    row("EDGAR_PROXY_TOKEN", false, "EDGAR relay"),
    row("KV_REST_API_URL", false, "Schwab: oo-trading's Redis store (shared login)"),
    row("KV_REST_API_TOKEN", false, "Schwab: oo-trading's Redis store (shared login)"),
    row("SCHWAB_CLIENT_ID", false, "Schwab: oo-trading's app (refresh the shared token)"),
    row("SCHWAB_CLIENT_SECRET", false, "Schwab: oo-trading's app (refresh the shared token)"),
    row("SCHWAB_APP_KEY", false, "Schwab market data (short interest)"),
    row("SCHWAB_APP_SECRET", false, "Schwab market data (short interest)"),
    row("SCHWAB_CALLBACK_URL", false, "Schwab market data (sign-in return address)"),
    row("FINNHUB_API_KEY", false, "Earnings drift: revenue vs consensus (optional; without it cards say revenue was not checked)"),
    row("FEC_API_KEY", false, "Investigations: campaign and PAC money (free from api.data.gov; without it a shared demo key)"),
    row("LDA_API_KEY", false, "Investigations: lobbying filings (optional, higher rate limit)"),
    row("YOUTUBE_API_KEY", false, "YouTube"),
    row("REDDIT_CLIENT_ID", false, "Reddit (after Data API approval)"),
    row("REDDIT_CLIENT_SECRET", false, "Reddit (after Data API approval)"),
    row("SWING_API_URL", false, "Swing ideas log"),
    row("SWING_API_USER", false, "Swing ideas log"),
    row("SWING_API_PASSWORD", false, "Swing ideas log"),
    row("SWING_API_BYPASS", false, "Swing ideas log (Vercel protection bypass)"),
    row("SWING_NOTIONAL", false, "Swing ideas log"),
    row("NTFY_TOPIC", false, "phone alerts (ntfy)"),
    row("NTFY_SERVER", false, "phone alerts (self-hosted ntfy, optional)"),
    row("NTFY_TOKEN", false, "phone alerts (protected ntfy, optional)"),
    row("RESEND_API_KEY", false, "email"),
    row("ALERT_EMAIL", false, "email"),
    row("DASHBOARD_URL", false, "email"),
  ];
}
