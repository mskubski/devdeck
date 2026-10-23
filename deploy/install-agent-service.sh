#!/bin/bash
# Installiert NUR den DevDeck Agent als systemd-User-Service (ohne Server) – für Entwicklungs-/Server-Rechner,
# auf denen kein DevDeck-Server laufen soll (z. B. helferle).
#
#   deploy/install-agent-service.sh             installieren/aktualisieren
#   deploy/install-agent-service.sh --replace   zusätzlich bereits laufende, von Hand gestartete Agent-Prozesse beenden
#
# Warum: Unter systemd wird der Agent nach einem Update zuverlässig neu gestartet (Exit-Code 75 → Restart=on-failure) und
# es gibt genau EINEN Agent-Prozess. Von Hand gestartete Prozesse (Terminal, nohup, tmux) werden dagegen leicht doppelt
# oder laufen weiter mit altem Code. Für Start ohne Login einmalig: sudo loginctl enable-linger "$USER"
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPLACE=0
[ "${1:-}" = "--replace" ] && REPLACE=1

if [ ! -f "$REPO/packages/agent/package.json" ]; then
  echo "Fehler: $REPO sieht nicht wie ein DevDeck-Checkout aus." >&2
  exit 1
fi

# Laufen schon Agent-Prozesse (nicht von systemd verwaltet)?
OTHERS="$(pgrep -af 'packages/agent/dist/index.js' || true)"
if [ -n "$OTHERS" ]; then
  echo "Bereits laufende Agent-Prozesse:"
  echo "$OTHERS" | sed 's/^/  /'
  if [ "$REPLACE" -ne 1 ]; then
    echo "Bitte mit --replace erneut ausführen (beendet diese Prozesse), damit nur der systemd-Dienst übrig bleibt." >&2
    exit 1
  fi
  systemctl --user stop devdeck-agent.service 2>/dev/null || true
  pkill -f 'packages/agent/dist/index.js' || true
  sleep 1
fi

(cd "$REPO" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)

mkdir -p "$UNIT_DIR"
# Agent-only: Abhängigkeit zum (hier nicht vorhandenen) Server-Dienst entfernen
sed -e "s|@REPO@|$REPO|g" -e '/devdeck-server/d' "$REPO/deploy/systemd/devdeck-agent.service" > "$UNIT_DIR/devdeck-agent.service"

systemctl --user daemon-reload
systemctl --user enable --now devdeck-agent.service
sleep 2
systemctl --user --no-pager status devdeck-agent | grep -E "●|Active:|Main PID:" || true
echo
echo "Agent läuft jetzt als systemd-Dienst aus: $REPO"
echo "Logs: journalctl --user -u devdeck-agent -f   (und ~/.devdeck/agent.log)"
