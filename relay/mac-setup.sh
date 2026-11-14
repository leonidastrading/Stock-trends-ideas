#!/bin/bash
# Installs the EDGAR relay as a background service on this Mac (starts at login, restarts if it stops).
# Run from the repo:  bash relay/mac-setup.sh
# Re-running is safe: it keeps the existing token and only refreshes the service.
set -euo pipefail

DIR="$HOME/.edgar-relay"
PORT=8787
LABEL="com.trendscout.edgar-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Install it from https://nodejs.org (LTS) or with: brew install node"; exit 1
fi
if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node 20 or newer is needed (found $("$NODE" -v))."; exit 1
fi

mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$DIR"
cp "$(dirname "$0")/server.mjs" "$DIR/server.mjs"

# Token: made once, kept in a file only you can read.
if [ ! -s "$DIR/token" ]; then
  (umask 077; openssl rand -hex 32 > "$DIR/token")
fi
TOKEN="$(cat "$DIR/token")"

# The SEC asks for "Name email" in the User-Agent of every request.
if [ ! -s "$DIR/user-agent" ]; then
  read -r -p "Your name and email for the SEC (e.g. Jane Doe jane@example.com): " UA
  (umask 077; printf '%s' "$UA" > "$DIR/user-agent")
fi
UA="$(cat "$DIR/user-agent")"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
umask 077
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(xml "$NODE")</string><string>$(xml "$DIR/server.mjs")</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>RELAY_TOKEN</key><string>$TOKEN</string>
    <key>SEC_USER_AGENT</key><string>$(xml "$UA")</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$DIR/relay.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$DIR/relay.log")</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1

echo
if curl -fsS "http://127.0.0.1:$PORT/health"; then echo; echo "Relay is running on port $PORT."; else echo "Relay did not start; see $DIR/relay.log"; exit 1; fi

# Quick check that the SEC accepts this network.
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/fetch?url=https%3A%2F%2Fefts.sec.gov%2FLATEST%2Fsearch-index%3Fq%3D%2522artificial%2520intelligence%2522%26forms%3D8-K")"
echo "SEC full-text search through the relay: HTTP $code (200 = good)"

cat <<NEXT

Next:
  1. Give the relay a public https address with Tailscale Funnel (free, address never changes):
       - install Tailscale from the Mac App Store and sign in
       - run:  tailscale funnel --bg $PORT
         (the first time it prints a link to switch Funnel on; open it, approve, run the command again)
       - it prints https://<this-mac>.<your-tailnet>.ts.net  -> that is EDGAR_PROXY_URL
     If "tailscale" is not found:  alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  2. In Vercel -> trend-scout -> Settings -> Environment Variables, set
       EDGAR_PROXY_URL   = the https address from step 1
       EDGAR_PROXY_TOKEN = the token printed by:  cat $DIR/token
     then redeploy.
  3. Keep the Mac awake around 6:30 am ET on weekdays (System Settings -> Battery/Energy ->
     "Prevent automatic sleeping when the display is off" while on power).
To stop:  launchctl bootout gui/\$(id -u)/$LABEL
NEXT
