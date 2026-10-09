#!/bin/bash
# Installiert DevDeck Server + Agent als systemd-User-Services.
# Aufruf: deploy/install-systemd.sh   (danach: systemctl --user status devdeck-server)
# Für Autostart ohne Login einmalig: sudo loginctl enable-linger "$USER"
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

(cd "$REPO" && npm run build >/dev/null)

mkdir -p "$UNIT_DIR"
for unit in devdeck-server devdeck-agent; do
  sed "s|@REPO@|$REPO|g" "$REPO/deploy/systemd/$unit.service" > "$UNIT_DIR/$unit.service"
done

systemctl --user daemon-reload
systemctl --user enable --now devdeck-server.service devdeck-agent.service
systemctl --user --no-pager status devdeck-server devdeck-agent | grep -E "●|Active:"
