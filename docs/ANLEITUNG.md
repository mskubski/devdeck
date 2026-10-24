# DevDeck – Starten & Anmelden (lokal auf dem Server)

Diese Anleitung beschreibt den Start von DevDeck auf diesem Rechner (`<server>`) und den
ersten Login. Sie ergänzt die Architektur-/Konzeptdokumente (`../README.de.md`, `DEVDECK_v5.md`)
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

`npm run build` kompiliert Server, Agent, CLI und das Shared-Paket nach `dist/`.
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
4. Die Maschine erscheint danach unter **Maschinen** in der Web-UI mit Status `online`. Ein Klick auf den Namen öffnet die **Detailseite** mit Inventar
   (Laufwerke, Gerät, Betriebssystem, Sicherheit, Verwaltung) und frei anlegbaren **Eigenen Feldern** (Agent ab 0.9.0; Windows, Linux, macOS).
   Ein Widerruf (z. B. bei Verlust des Rechners) ist dort jederzeit mit einem Klick möglich.

> Es gibt aktuell kein global installiertes `devdeck-agent`-Kommando (Packaging ist Teil der
> DevDeck-CLI-Phase) – der Agent wird direkt per `node .../dist/index.js`
> aus dem Repository heraus gestartet.

## 7. Workspace registrieren und synchronisieren

1. Im Projekt → Tab **Workspaces** → **„+ Workspace registrieren“**: lokalen Pfad auf dem
   Entwicklungsrechner und die zugehörige Maschine angeben.
2. **Sync** prüft den Git-Status und aktualisiert nur per Fast-Forward – bei lokalen,
   nicht committeten Änderungen bricht der Agent sicherheitshalber ab, statt etwas zu
   überschreiben.
3. **Provision** richtet einen neuen/leeren Workspace komplett ein (Clone, Toolchain-Check,
   Dependencies, autorisierte Secrets/`.env`, Coding-Context).

4. **Deploy** (Maintainer, Linux, Agent ab 0.8.0) für Software, die auf der Maschine produktiv läuft (z. B. helferle): holt per Fast-Forward den
   neuesten Stand des Workspace-Branches, startet die im Manifest genannten systemd-Benutzerdienste neu und prüft, ob sie gesund sind; sonst
   automatische Rücknahme auf den alten Commit. Konfiguration im Repository, `.devdeck/workspace.yaml`:

   ```yaml
   deploy:
     timeout_seconds: 60
     install: .venv/bin/pip install -r requirements.txt   # optional
     services:
       - unit: helferle-api
         health_url: http://localhost:5001/v1/health
       - unit: helferle-gui
         health_url: http://localhost:5000/login
       - unit: helferle          # nur is-active
   ```

   Ablauf für ein Projekt wie helferle: lokal mit Claude Code entwickeln → PR/Merge nach `main` → in DevDeck **Projekt → Workspaces → Deploy**.
   Voraussetzungen: Dienste als **Benutzer-Units** (`systemctl --user`, ggf. `loginctl enable-linger`), Agent ab 0.8.0 (Server-Update mit „Agents mit aktualisieren“),
   saubere Arbeitskopie auf der VM. Vercel-Projekte (Deploy per Git-Push) brauchen das nicht.
   Bricht das Deploy mit „lokale Änderungen“ ab, nennt die Meldung die Dateien (auch im Sync-Log): auf der Maschine committen oder entfernen.

## 7b. Bestehende Projektdaten importieren und Coding-Regeln

- **Importieren:** Projekt → **Workspaces** → **Importieren** (Maintainer). Der Agent liest im Workspace `CHANGELOG.md`,
  `ROADMAP.md`/`TODO.md`, `.env`, `.env.<umgebung>` und `credentials.md`, zeigt eine Vorschau (Secret-Namen, nie Werte) und
  importiert nach Bestätigung. Wähle die Umgebung für die Secrets (z. B. `production`). Wiederholen ist gefahrlos
  (vorhandene Einträge werden übersprungen). Voraussetzung: Agent ab Version 0.4.0 (Server-Update mit „Agents mit aktualisieren“).
  Alternative per CLI: `devdeck import all` bzw. `--apply`.
- **Umgebungen (development / staging / production):** Sie trennen Secret-Werte nach Einsatzzweck. *development* = Entwicklung auf dem Rechner
  (Testwerte, Sandbox-Schlüssel; nur diese Umgebung schreibt DevDeck standardmäßig in die lokale `.env`), *staging* = Probelauf in einer
  Testumgebung, die dem Live-Betrieb gleicht (mit Testdaten), *production* = Live-Betrieb mit den echten Schlüsseln und Konten.
  Derselbe Name kann je Umgebung einen anderen Wert haben. Läuft die Software auf der Maschine produktiv (z. B. helferle), importiere die `.env` als
  *production*; Abruf anderer Umgebungen: `devdeck env run --environment production -- <befehl>`.
- **Regeln für Claude Code:** Bei Sync/Provision schreibt der Agent `.devdeck/` und `.claude/rules/devdeck.md` (Kontext lesen,
  nach jeder Änderung bauen/testen/committen/pushen). Beide Pfade werden lokal über `.git/info/exclude` ignoriert; das
  Repository bleibt sauber. Wer eigene Regeln in `CLAUDE.md` pflegt, setzt dort den Marker `<!-- devdeck:rules-included -->`.
- **„Agent updaten“ meldet Erfolg, die Version bleibt aber alt:** Der Update-Auftrag holt den Code, baut ihn, startet den neuen Code probeweise (Fehler → Abbruch, alter Agent läuft weiter)
  und startet neu. Bleibt die gemeldete Version trotzdem alt, zeigt **Maschinen** den Hinweis „Update nicht angekommen“ mit Startdatei, Commit und Node-Version des laufenden Prozesses (ab Agent 0.7.0).
  Meist läuft ein zweiter, älterer Agent-Prozess parallel oder der Agent wird aus einem anderen Ordner/Container gestartet. Auf der Maschine prüfen: `ps -eo pid,lstart,cmd | grep "[a]gent/dist"` –
  es darf genau einen Agent-Prozess geben (alle anderen beenden, einmal sauber neu starten, z. B. `systemctl --user restart devdeck-agent`).
- **Update-Fehler „no such ref was fetched“:** Der Ordner stand auf einem Feature-Branch, dessen Remote-Branch nach dem Merge gelöscht wurde. Server- und Agent-Update wechseln jetzt selbstständig auf `main`
  (nur mit sauberem Ordner, nur per Fast-Forward; Zielbranch `DEVDECK_UPDATE_BRANCH`). Von Hand gepullter Code wird beim nächsten „Server aktualisieren“ trotzdem gebaut und neu gestartet.
- **Agent als Dienst unter Linux (empfohlen):** `deploy/install-agent-service.sh [--replace]` installiert nur den Agenten als systemd-Benutzerdienst (kein Server) – ein Prozess, zuverlässiger Neustart
  nach Updates. `--replace` beendet vorher von Hand gestartete Agent-Prozesse. Für Start ohne Login einmalig `sudo loginctl enable-linger $USER`.
- **Workspace-Status (ready / warning / blocked / unknown):** Der Status kommt vom Agenten und fasst die Prüfpunkte zusammen (Git, Repository,
  Toolchain/Abhängigkeiten laut optionalem Manifest, `.env` nur bei verlangter Projektion, Kontext, Abgleich mit GitHub). Ein Klick auf den Status
  im Tab **Workspaces** zeigt jeden Prüfpunkt mit Begründung; **Prüfen** liest den Zustand neu (ohne Sync). `unknown` heißt „noch nie geprüft“ und
  verschwindet automatisch kurz nach dem Registrieren bzw. sobald der Agent online ist. Typische Hinweise: *„N Commits nicht gepusht“* (pushen),
  *„Ordner existiert noch nicht“* (Provision), *„lokale Änderungen“* (committen).
- **Sync/Provision schlägt mit „außerhalb des Workspace-Root“ fehl:** Der Workspace-Pfad muss immer unterhalb des Workspace-Roots der Maschine
  liegen. DevDeck prüft das jetzt schon beim Registrieren/Bearbeiten und zeigt den Root an. Falsche Pfade korrigierst du im Tab **Workspaces**
  mit **Bearbeiten** (oder **Entfernen** – löscht nur die Registrierung, nie Dateien). Den Root selbst änderst du unter **Maschinen** → „Root ändern“.

## 7c. Architektur-Karte (Projekt-Übersicht)

Das weiße Feld unten auf der Projekt-Übersicht (unter Kennzahlen, Projektinfo und letzten Sessions) zeigt Entwicklung → GitHub → Betrieb/Hosting → Datenbank sowie alle externen Dienste (Mail, Telegram, KI-Anbieter,
Karten, Newsletter, Zahlung …) mit Beschreibungen und beschrifteten Beziehungen. Quellen (Vorrang: manuell > Manifest > automatisch):

1. **Automatisch:** Der Agent liest bei jeder Workspace-Prüfung nur *Namen* der `.env`-Variablen, bereinigte Hostnamen (ohne Zugangsdaten, nur für Variablen wie `*_HOST`/`*_URL`),
   Abhängigkeiten, Hosting-Dateien (`vercel.json`, Dockerfile, systemd) und lokale SQLite-Dateien samt Größe. Server-seitig kommen Maschinen, Repository und Secret-Namen dazu.
2. **Manifest `.devdeck/architecture.yaml`** (versioniert im Repository): Beschreibungen, Beziehungen, Betriebsort, Datenbank-Details. Claude Code pflegt sie über die Regel in
   `.claude/rules/devdeck.md` bei jeder Änderung mit; Format siehe Knopf „Wie wird das gepflegt?“ oder `RULES.md`.
3. **Manuell im UI** (Maintainer): Karte anklicken → bearbeiten/ausblenden/zurücksetzen, „+ Komponente“, „+ Beziehung“.

„Aktualisieren“ löst eine neue Prüfung aller Workspaces aus. Voraussetzung: Agent ab Version 0.6.0. Supabase-Größe, Vercel- und IONOS-Live-Daten folgen mit eigenen Konnektoren.
Gestrichelt dargestellt ist, was noch offen ist (z. B. „Betrieb: noch nicht festgelegt“ – dann `kind: hosting` im Manifest ergänzen).

## 8. Troubleshooting

| Problem | Ursache / Lösung |
|---|---|
| Login schlägt fehl, obwohl die gedruckten Zugangsdaten stimmen | Die Datenbank hatte beim Start schon Benutzer – der Admin-Bootstrap läuft **nur beim allerersten Start**. Vorhandene Admin-E-Mail über einen bereits aktiven Admin-Account prüfen/zurücksetzen. |
| `http://<server>:8080` ist von einem anderen Rechner nicht erreichbar | Prüfen, ob `DEVDECK_HOST=0.0.0.0` gesetzt ist (nicht `127.0.0.1`) und ob eine Firewall Port 8080 blockiert. |
| Maschine bleibt „offline“ | Agent läuft nicht, oder Heartbeat erreicht den Server nicht (Server-URL/Netzwerk prüfen). Nach 90 s ohne Heartbeat markiert der Server die Maschine automatisch als offline. |
| Secret-Wert lässt sich nicht anzeigen | Dafür ist die Capability `secret.reveal` nötig (implizit bei Projektrolle `owner`/`maintainer`). Siehe Hilfe-Seite „Secrets & DevDeck Vault“. |

## 9. Am PC entwickeln und auf dem Server ausrollen

Beispiel: Entwicklung auf dem Windows-PC `mauriceZ`, DevDeck läuft produktiv auf `debian01`. Der Quellcode reist
**nur über GitHub**; DevDeck überträgt keinen Code.

1. **Am PC entwickeln.** Im Workspace-Ordner (z. B. `D:\DEVDECK\DEV\devdeck`) mit Claude Code arbeiten. Läuft der Agent
   und ist der Workspace registriert, erscheint die Sitzung automatisch im Tab **Sessions**.
2. **GitHub aktualisieren – nach jeder Code-Anpassung.** Das erledigt Claude Code selbst (Regel in `CLAUDE.md`):
   `npm run build && npm test`, Feature-Branch committen und pushen, Pull Request öffnen und Auto-Merge
   einschalten (`gh pr merge --auto --merge`): GitHub mergt nach `main`, sobald die CI grün ist. (`main` ist durch den Check `build-and-test` geschützt; der PC braucht GitHub-Zugangsdaten und `gh`.)
3. **Server aktualisieren – ein Klick:** In DevDeck unter **System** → **„Server aktualisieren“**. Der Server erstellt
   automatisch ein Backup, holt `main` von GitHub (nur Fast-Forward), führt `npm ci` und den Build aus und startet sich
   neu (wenige Sekunden). Schlägt ein Schritt fehl, wird auf den vorherigen Stand zurückgesetzt und der Server läuft
   unverändert weiter. Das geht von jeder Maschine aus, auf der du in DevDeck angemeldet bist.
4. **Agents:** Das Häkchen „Danach auch alle online befindlichen Agents aktualisieren“ (Standard an) beauftragt alle
   Agents ab Version 0.2.0, sich selbst zu aktualisieren (Fast-Forward-Pull, `npm ci`, Build, Neustart) – ein Klick für
   alles. Ältere Agents werden übersprungen und müssen einmalig von Hand aktualisiert werden. Einzelne Agents gehen
   weiterhin unter **Maschinen** → „Agent updaten“. Projekt-Workspaces danach mit **Sync** (`devdeck sync`) nachziehen.
5. **Optional – automatisches Update:** Auf der Seite **System** einschalten. Der Server prüft dann einmal pro Nacht
   (Standard 03:00 Serverzeit, wählbar), ob `main` neuer ist, und aktualisiert sich samt Agents. Nur mit sauberem
   Server-Ordner, mit vorherigem Backup, höchstens einmal pro Tag und nicht, während ein Agent-Auftrag läuft.
   Standardmäßig **aus**; das Ergebnis steht auf der System-Seite unter „Letztes Update“.

Einmalig nötig: Der Server muss den Update-Knopf selbst erst haben. Auf dem Server-Rechner dafür einmal von Hand
`git checkout main && git pull --ff-only && npm ci && npm run build && systemctl --user restart devdeck-server devdeck-agent`
ausführen; ab dann genügt der Knopf. Voraussetzung: Der Server läuft per systemd (`deploy/install-systemd.sh`),
sonst muss er nach dem Update von Hand neu gestartet werden. Zielbranch: `DEVDECK_UPDATE_BRANCH` (Standard `main`).

Hinweise:
- Bricht das Server-Update oder „Agent updaten“ wegen lokaler Änderungen ab, liegen im Server-/Agent-Ordner uncommittete
  Änderungen – diese committen und pushen (bzw. verwerfen) und es erneut versuchen.
- Tasks, Changelog und Entscheidungen liegen in der DevDeck-Datenbank, nicht in Git. Vorhandene Dateien
  (`CHANGELOG.md`, `ROADMAP.md`, `.env`) lassen sich mit `devdeck import all` übernehmen.
- Der Agent startet unter Windows nicht automatisch; nach einem Neustart des PCs erneut starten:
  `node packages/agent/dist/index.js start --workspace-root D:\DEVDECK\DEV`.

## Backups, CLI und Integrationen

- **Backups:** Als Admin unter **Backups** in der Web-UI. Automatisch täglich (`DEVDECK_BACKUP_INTERVAL_HOURS`),
  Ziel über `DEVDECK_BACKUP_TARGET`, Aufbewahrung 7 täglich + 4 wöchentlich. Der Vault-Key wird nicht mitgesichert –
  separat aufbewahren. **Restore** nur im Terminal bei gestopptem Server:
  `node packages/server/dist/restore.js <backup-ordner>` (Zeitstempel und `RESTORE` eintippen).
- **CLI:** `node packages/cli/dist/index.js help` zeigt alle Befehle (`login`, `status`, `sync`, `context`,
  `session start|finish`, `handover import`, `task|changelog|decision add`, `secret list`, `env run -- <cmd>`).
  `devdeck claude` bzw. `devdeck codex` startet den Coding Agent im Workspace mit aktuellem Kontext und Coding Session.
- **Import bestehender Projektdaten:** Im Workspace-Ordner `devdeck import all` (Vorschau) bzw. `devdeck import all --apply`.
  Liest `CHANGELOG.md`, `ROADMAP.md`/`TODO.md` (Checkboxen `- [ ]`/`- [x]`, optional `(P1)`–`(P5)`) sowie `.env`,
  `.env.<umgebung>` und `credentials.md` (Zeilen `KEY=wert`, `KEY: wert` oder Tabellenzeilen). Bereits vorhandene
  Einträge werden übersprungen; Secrets landen verschlüsselt im Vault, ihre Werte werden nie angezeigt.
- **Claude-Code-Sessions:** Der Agent liest alle 5 Minuten die Claude-Code-Transcripts (`~/.claude/projects`, unter
  Windows im Benutzerordner `.claude\projects`; anderer Ort über `CLAUDE_CONFIG_DIR`) für registrierte Workspaces und meldet
  nur Metadaten (Titel, Zeiten, Branch, PR-Link, Nachrichtenanzahl) – keine Prompts. Anzeige im Tab **Sessions** (Quelle
  „Claude Code (automatisch)“) und auf der Projektübersicht. Abschalten: `DEVDECK_SCAN_SESSIONS=0`.
  Voraussetzung: Der Workspace ist für diese Maschine registriert.
- **Wissen:** Im Projekt gibt es die Tabs **Entscheidungen**, **Changelog**, **Known Issues** und **Verlauf**.
- **Integrationen:** Tab **Integrationen** – GitHub-Konnektor mit Token aus einem Projekt-Secret.
