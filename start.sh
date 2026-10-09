#!/bin/bash

# DevDeck Service Start Script
# Startet alle DevDeck-Services und bindet an 0.0.0.0 für externe Zugriffe

set -euo pipefail

cd "$(dirname "$0")"

echo "🔧 Baue alle DevDeck-Pakete..."
npm run build > /dev/null 2>&1 || echo "⚠️  Warnung: Build hatte teilweise Fehler"

# Setze Umgebungsvariablen für externen Zugriff
export DEVDECK_HOST=0.0.0.0
export DEVDECK_PORT=8080

# Initialer Admin wird NUR beim allerersten Start angelegt (wenn noch keine
# Benutzer existieren). Ohne diese beiden Variablen bootstrapped der Server
# keinen Admin und niemand kann sich einloggen (packages/server/src/index.ts).
# Beide Werte müssen vor dem Aufruf von start.sh gesetzt werden (keine Defaults).
: "${DEVDECK_ADMIN_EMAIL:?Bitte DEVDECK_ADMIN_EMAIL setzen}"
: "${DEVDECK_ADMIN_PASSWORD:?Bitte DEVDECK_ADMIN_PASSWORD setzen}"
export DEVDECK_ADMIN_EMAIL DEVDECK_ADMIN_PASSWORD

echo ""
echo "🚀 Starte DevDeck Server (bindet an alle Netzwerk-Interfaces)..."
echo "   URL: http://localhost:8080 und http://<DEINE-IP>:8080"
node packages/server/dist/index.js &
SERVER_PID=$!

# Warte, bis Server online ist
echo "⌛ Warte auf Server-Start..."
for i in {1..30}; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ | grep -qE "200|404|500"; then
    echo "✅ Server ist online auf http://localhost:8080"
    break
  fi
  sleep 1
done

echo ""
echo "🚀 Starte DevDeck Agent..."
node packages/agent/dist/index.js &
AGENT_PID=$!

sleep 2

echo ""
echo "================================================================================="
echo "DevDeck Services Status"
echo "================================================================================="
echo "🟢 Server:       http://localhost:8080 und http://<server>:8080 (PID: $SERVER_PID)"
echo "🟢 Agent:        läuft im Hintergrund (PID: $AGENT_PID)"
echo "================================================================================="
echo ""
echo "🔗 Zugriffs-URLs:"
echo "  Lokal:         http://localhost:8080"
echo "  Vom PC:        http://<server>:8080"
echo ""
echo "🏥 Health-Check:  http://localhost:8080/health"
echo ""
echo "🔐 Login-Info (nur beim allerersten Start wirksam):"
echo "  E-Mail:        ${DEVDECK_ADMIN_EMAIL}"
echo "  ⚠️  Bitte nach dem ersten Login in der Benutzerverwaltung ändern."
echo "  (eigene Werte: DEVDECK_ADMIN_EMAIL/DEVDECK_ADMIN_PASSWORD vor dem Start exportieren)"
echo ""
echo "⚙️  API-Endpunkte:"
echo "  POST /api/auth/login"
echo "  GET  /api/auth/me"
echo "  POST /api/auth/logout"
echo "  GET/POST /projects/:projectId/secrets (Vault)"
echo ""
echo "================================================================================="
echo "Zum Beenden:"
echo "  pkill -f 'node packages/server/dist/index.js'"
echo "  pkill -f 'node packages/agent/dist/index.js'"
echo "================================================================================="
