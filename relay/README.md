# EDGAR relay

The SEC's full-text search host (`efts.sec.gov`) refuses requests from Vercel's addresses with a 403 whatever the
User-Agent, while the rest of sec.gov answers normally. This relay runs on another network (for example the Railway
project that already hosts the news-alerts worker) and forwards the scout's EDGAR searches.

It is one file with no dependencies. It accepts `GET /fetch?url=<encoded url>` with `Authorization: Bearer $RELAY_TOKEN`,
forwards the request to an allow-listed host (`efts.sec.gov` by default) with the declared SEC User-Agent, and returns the
upstream status and body. Anything else is refused. `GET /health` reports the allowed hosts.

## Deploy on Railway

1. Railway → New Project → Deploy from GitHub repo → this repository. In the service's **Settings → Source**, set the
   **Root Directory** to `relay`. Railway detects Node and runs `npm start`.
2. Variables: `RELAY_TOKEN` (a long random string; `openssl rand -hex 32`), `SEC_USER_AGENT` (`Your Name you@example.com`).
3. Settings → Networking → **Generate Domain**. Check `https://<domain>/health`.
4. In the Vercel `trend-scout` project add `EDGAR_PROXY_URL=https://<domain>` and `EDGAR_PROXY_TOKEN=<the same token>`,
   then redeploy. The EDGAR row on Settings turns "ok" after the next scan.

If the SEC also blocks that network, the health panel says so (the relay passes the 403 through unchanged) and the
relay can be moved; nothing else changes.
