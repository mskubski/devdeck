# DevDeck – Starten & Anmelden (lokal auf dem Server)

Diese Anleitung beschreibt den Start von DevDeck auf diesem Rechner (`<server>`) und den
ersten Login. Sie ergänzt die Architektur-/Konzeptdokumente (`README.de.md`, `DEVDECK_v5.md`)
um die reinen Bedienschritte.

## 1. Voraussetzungen

- Node.js ≥ 22.5 (installiert: `node -v` → `v22.23.3`)
- `npm`
- `git` (für Agent-Aktionen wie Workspace-Sync/-Provision auf Entwicklungsrechnern)

Einmalig nach dem Klonen bzw. nach Codeänderungen:

```bash
cd /path/to/devdeck
npm install
npm run build
```

`npm run build` kompiliert Server, Agent, CLI-Gerüst und das Shared-Paket nach `dist/`.
Die Web-UI (`packages/server/src/webui/`) ist reines HTML/CSS/JS ohne Build-Schritt – der
Server liest sie direkt aus dem Quellverzeichnis.

## 2. Server starten

### Variante A – `start.sh` (empfohlen für Linux-Server)

```bash
./start.sh
```

`start.sh` baut das Projekt, bindet den Server an `0.0.0.0:8080` (damit er auch von anderen
Rechnern im Netz unter `http://<server>:8080` erreichbar ist) und zeigt am Ende die
Zugriffs-URLs sowie die Login-Daten des **initialen Admins** an.

> **Wichtig:** Der initiale Admin wird **nur beim allerersten Start** angelegt, wenn die
> Datenbank noch leer ist. `DEVDECK_ADMIN_EMAIL` und `DEVDECK_ADMIN_PASSWORD` müssen vor dem
> Start gesetzt werden – `start.sh` hat bewusst keine Default-Werte. **Bitte das Passwort nach
> dem ersten Login ändern** (siehe Schritt 4).
>
> ```bash
> export DEVDECK_ADMIN_EMAIL="du@example.com"
> export DEVDECK_ADMIN_PASSWORD="<sicheres-passwort>"
> ./start.sh
> ```

Beenden:

```bash
pkill -f 'node packages/server/dist/index.js'
pkill -f 'node packages/agent/dist/index.js'
```

### Variante B – Server manuell starten (mehr Kontrolle)

```bash
export DEVDECK_HOST=0.0.0.0          # oder 127.0.0.1, wenn nur lokal erreichbar
export DEVDECK_PORT=8080
export DEVDECK_ADMIN_EMAIL="du@example.com"
export DEVDECK_ADMIN_PASSWORD="EinSicheresPasswort123!"
node packages/server/dist/index.js
```

Relevante weitere Umgebungsvariablen (siehe `packages/server/src/config.ts`):

| Variable | Zweck | Default |
|---|---|---|
| `DEVDECK_DATA_DIR` | Speicherort für SQLite-DB und Vault | `./data` |
| `DEVDECK_VAULT_KEY` | Vault-Masterkey als Base64 (32 Byte) – sonst wird `vault.key` automatisch erzeugt | – |
| `DEVDECK_SESSION_TTL_DAYS` | Gültigkeit der Browser-Session | `14` |
| `DEVDECK_SECURE_COOKIES` | `1` setzen, sobald DevDeck hinter HTTPS läuft | `0` |

Den Health-Check prüfen:

```bash
curl http://localhost:8080/api/health
```

## 3. Anmelden

1. Im Browser öffnen:
   - lokal auf dem Server: `http://localhost:8080`
   - von einem anderen Rechner im selben Netz: `http://<server>:8080`
     (bzw. `http://<IP-des-Servers>:8080`, falls der Hostname nicht auflösbar ist)
2. Mit der beim Start angezeigten E-Mail/Passwort-Kombination anmelden.
3. Nach dem Login landet man auf der Projektübersicht. Die Seitenleiste führt zu
   Projekten, Maschinen, Benutzerverwaltung (nur Admin), Audit-Log und Hilfe. Die
   **Hilfe-Seite** in der Anwendung erklärt jede Funktion im Detail.

## 4. Admin-Passwort ändern (dringend empfohlen)

1. Sidebar → **Benutzer** (nur als Admin sichtbar).
2. Beim eigenen Account auf **„Passwort setzen“** klicken, neues Passwort eingeben.
3. Alle bestehenden Sessions dieses Benutzers werden dabei automatisch beendet – danach
   einmal neu anmelden.

## 5. Erstes Projekt anlegen

1. Sidebar → **Projekte** → **„+ Neues Projekt“** (nur Admin kann Projekte anlegen).
2. Name, optional Beschreibung und Git-Remote eintragen.
3. Im Projekt unter **Mitglieder** weitere Benutzer mit einer Projektrolle
   (`viewer`/`developer`/`maintainer`/`owner`) hinzufügen.

## 6. Einen Entwicklungsrechner verbinden (DevDeck Agent)

Der DevDeck Agent läuft auf jedem Entwicklungsrechner, auf dem tatsächlich programmiert
wird (nicht zwingend auf dem Server selbst). Pro Maschine braucht es einmalig:

1. Im Projekt, oder global als Admin: Sidebar → **Maschinen** → **„+ Enrollment-Token
   erzeugen“**. Das Token wird nur einmal angezeigt.
2. Auf dem Zielrechner, im dort ausgecheckten DevDeck-Repository:
   ```bash
   npm install && npm run build   # einmalig
   node packages/agent/dist/index.js enroll --server http://<server>:8080 --token <TOKEN>
   ```
3. Danach den Agenten dauerhaft starten (z. B. als systemd-Service oder im Hintergrund):
   ```bash
   node packages/agent/dist/index.js start
   ```
   Der Agent meldet sich per Heartbeat (alle 30 s) und fragt Kommandos per Long-Poll ab –
   es sind **keine eingehenden Ports** auf dem Entwicklungsrechner nötig.
4. Die Maschine erscheint danach unter **Maschinen** in der Web-UI mit Status `online`.
   Ein Widerruf (z. B. bei Verlust des Rechners) ist dort jederzeit mit einem Klick möglich.

> Es gibt aktuell kein global installiertes `devdeck-agent`-Kommando (Packaging ist Teil der
> noch ausstehenden DevDeck-CLI-Phase) – der Agent wird direkt per `node .../dist/index.js`
> aus dem Repository heraus gestartet.

## 7. Workspace registrieren und synchronisieren

1. Im Projekt → Tab **Workspaces** → **„+ Workspace registrieren“**: lokalen Pfad auf dem
   Entwicklungsrechner und die zugehörige Maschine angeben.
2. **Sync** prüft den Git-Status und aktualisiert nur per Fast-Forward – bei lokalen,
   nicht committeten Änderungen bricht der Agent sicherheitshalber ab, statt etwas zu
   überschreiben.
3. **Provision** richtet einen neuen/leeren Workspace komplett ein (Clone, Toolchain-Check,
   Dependencies, autorisierte Secrets/`.env`, Coding-Context).

## 8. Troubleshooting

| Problem | Ursache / Lösung |
|---|---|
| Login schlägt fehl, obwohl die gedruckten Zugangsdaten stimmen | Die Datenbank hatte beim Start schon Benutzer – der Admin-Bootstrap läuft **nur beim allerersten Start**. Vorhandene Admin-E-Mail über einen bereits aktiven Admin-Account prüfen/zurücksetzen. |
| `http://<server>:8080` ist von einem anderen Rechner nicht erreichbar | Prüfen, ob `DEVDECK_HOST=0.0.0.0` gesetzt ist (nicht `127.0.0.1`) und ob eine Firewall Port 8080 blockiert. |
| Maschine bleibt „offline“ | Agent läuft nicht, oder Heartbeat erreicht den Server nicht (Server-URL/Netzwerk prüfen). Nach 90 s ohne Heartbeat markiert der Server die Maschine automatisch als offline. |
| Secret-Wert lässt sich nicht anzeigen | Dafür ist die Capability `secret.reveal` nötig (implizit bei Projektrolle `owner`/`maintainer`). Siehe Hilfe-Seite „Secrets & DevDeck Vault“. |
