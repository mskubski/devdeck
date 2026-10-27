# Changelog

## Unreleased - 2026-10-23

### Added
- **Maschine hinzufügen mit Installations-Dialog**: Nach dem Erzeugen des Enrollment-Tokens Betriebssystem wählen (Windows, Linux, macOS) und ein **Installationsskript herunterladen** (`install-devdeck-agent.ps1` / `.sh`) oder die **Befehle kopieren**. Das Skript prüft Git und Node.js (Windows: Installation per winget auf Nachfrage),
  fragt Installationsordner, Workspace-Root, Maschinenname und Autostart ab (Vorschläge aus dem Formular), klont und baut den Agent, registriert die Maschine, richtet den Autostart ein und startet den Agent. Skripte werden im Browser erzeugt, das Token wird nirgends gespeichert; Eingaben werden gegen Zeichen geprüft, die Befehle einschleusen könnten.
  Neue Agent-Befehle `autostart on|off|status` und `start-background`.
- Fix: Der Autostart-Schalter ist jetzt ein echter Schiebeschalter (die Umstellung war nach dem Merge von PR 37 nicht mehr auf `main` gelandet).
- **Updates installieren** im Tab „Patches“ (Agent 0.15.0): einzeln oder mehrere auf einmal, für Windows (Windows Update Agent, winget), Linux (apt, dnf) und macOS (softwareupdate, Homebrew). Zulässig ist nur, was eine frische Prüfung als ausstehend meldet (Allowlist-Aktion `patches.install`, strenge Kennungsprüfung, keine Shell);
  ein nötiger Neustart wird nie ausgeführt, nur angezeigt. Ergebnis je Update, sofort aktualisierter Patch-Stand. Voraussetzungen: Windows-Agent mit Administratorrechten, Linux/macOS Root oder sudo ohne Passwort. API `POST /api/machines/:id/patches/install`, Audit-Eintrag.
- **Sicherheitshinweis in der Kopfleiste**: Schild-Symbol mit Anzahl der Maschinen mit ausstehenden sicherheitsrelevanten Updates (rot bei kritischen), Klick listet sie und führt zum Tab „Patches“. API `GET /api/machines/security-summary`.
- **Schalter „Autostart“ je Maschine** (Maschinenliste und Detailseite, Agent 0.14.0, Migration v17): nimmt den Agent in den Autostart auf bzw. wieder heraus – Windows: Run-Eintrag des Benutzers (ohne Fenster), Linux: systemd-Benutzerdienst, macOS: LaunchAgent; ohne Administratorrechte, der laufende Agent wird nicht gestoppt oder doppelt gestartet.
  Neue Agent-Aktion `agent.autostart`, Zustand kommt per Heartbeat (stündlich) bzw. sofort nach dem Umschalten; API `POST /api/machines/:id/autostart {enabled}` (Besitzer/Admin, Audit-Eintrag).
- **GitHub-Issue-Abgleich** (Integrationen → GitHub-Konnektor → „Issue-Abgleich einschalten“, Migration v18): Tasks und Known Issues werden in beide Richtungen mit den GitHub Issues synchronisiert – lokale Änderungen nach wenigen Sekunden,
  Änderungen auf GitHub alle 5 Minuten oder per „Jetzt abgleichen“. Zuordnung: Tasks = Issues ohne Label `bug`/`known-issue`, Known Issues = Issues mit `bug` oder `known-issue`; verwaltete Labels `P1`–`P5`, `in-progress`, `known-issue`, `severity-*`.
  Änderungserkennung per Hash (nur die geänderte Seite wird übernommen, bei beidseitiger Änderung gewinnt GitHub), Pull Requests werden ignoriert, höchstens 50 neue Issues je Lauf, gelöschte Issues werden nicht neu angelegt. Aus per Standard; Einschalten verlangt eine Bestätigung.
  Tasks und Known Issues zeigen die Issue-Nummer als Link. API: `GET .../connectors/:id/sync/preview`, `PUT .../sync`, `POST .../sync/run`.
- **Tab „Logs“** auf der Maschinen-Detailseite (Agent 0.13.0, Migration v16): Fehlerprotokolle (nur Kritisch/Fehler) mit Zeit, Log (Herkunft), Quelle, ID, Ebene und Meldung, mit Suche sowie Filter nach Log und Ebene.
  Der Agent liest alle 15 Minuten nur Neues: Windows Ereignisanzeige (System, Application), Linux systemd-Journal (System/Kernel) und dmesg, macOS Systemprotokoll (`log show`) und Absturzberichte.
  **Aufbewahrung 30 Tage** (Löschung beim Eintreffen neuer Logs und alle 6 Stunden) plus Obergrenze 5000 Einträge je Maschine; Doppelte werden ignoriert. API `GET /api/machines/:id/logs`.
- **Tab „Patches“** auf der Maschinen-Detailseite (Agent 0.12.0, Migration v15): ausstehende Updates mit Status Kritisch/Sicherheit/Update verfügbar, Zusammenfassung (Anzahl, Neustart erforderlich, zuletzt installiert) und zuletzt installierte Updates.
  Der Agent prüft beim Start und alle 6 Stunden: Windows über den Windows Update Agent und `winget`, Linux über `apt`/`dnf`/`checkupdates`, macOS über `softwareupdate` und Homebrew. Kein Hersteller-Scanner: gelistet wird nur, was ein Update braucht.
  API `GET /api/machines/:id/patches`. Der Versionstest im Agent ist nicht mehr an eine feste Versionsnummer gebunden.
- **Tab „Anwendungen“** auf der Maschinen-Detailseite (Agent 0.11.0, Migration v14): installierte Software mit Name, Version, Hersteller, Kennung und Quelle, mit Suche und Quellenfilter. Der Agent liest sie beim Start und stündlich:
  Windows aus den Uninstall-Schlüsseln der Registry (MSI, klassische und Benutzerinstallationen), Linux per dpkg/rpm/pacman sowie snap/flatpak, macOS per system_profiler und Homebrew. Serverseitig auf bekannte Felder, Längen und höchstens 2500 Einträge begrenzt;
  API `GET /api/machines/:id/applications` (eigener Aufruf, nicht im Detail).
- **Tab „Inventar“** auf der Maschinen-Detailseite (Agent 0.10.0): Gerät, Sicherheit (inkl. TPM-Hersteller/-Spezifikation), Prozessor (Kerne, Takt, Cache, Architektur), BIOS, Speichermodule (Hersteller, Kapazität, Teilenummer, Steckplatz, Bauform, Geschwindigkeit)
  und Netzwerkverbindungen (MAC, IPv4/IPv6, verbunden) – je Abschnitt mit Zeitstempel. Windows per CIM/PnP, Linux per lscpu/dmidecode (Root)/ip, macOS per sysctl/system_profiler/ifconfig; serverseitig wie das übrige Inventar auf bekannte Felder und Längen begrenzt.
- **Maschinen-Details:** Klick auf den Namen unter Maschinen öffnet eine Detailseite (Tab „Übersicht“, weitere Tabs vorbereitet) mit Laufwerken, Gerät, Betriebssystem, Sicherheitsstatus, Verwaltung und **Eigenen Feldern**
  (Bezeichnung/Wert, Besitzer oder Admin). Der Agent (0.9.0, Migration v13) sammelt das Inventar auf Windows (PowerShell/CIM), Linux (/sys, os-release, df, systemctl) und macOS (system_profiler, sw_vers, fdesetup …)
  beim Start und alle 15 Minuten; nur Metadaten, serverseitig auf bekannte Felder und Längen begrenzt. API: `GET /api/machines/:id` (mit Inventar), `PUT /api/machines/:id/custom-fields`.
- **Deploy pro Workspace** (Agent 0.8.0, Aktion `workspace.deploy`, Knopf „Deploy“ unter Projekt → Workspaces, Maintainer): holt per Fast-Forward den Stand des Branches, startet die im Manifest
  (`.devdeck/workspace.yaml`, Block `deploy`) genannten systemd-Benutzerdienste neu und prüft sie (HTTP 2xx auf localhost bzw. `is-active`); bei Fehlern automatische Rücknahme auf den alten Commit.
  Optionaler Install-Befehl, Ergebnis mit allen Schritten im Dialog und im Sync-Log, Audit `workspace.deploy.request`. Nur Linux; Dienste/Befehle stammen ausschließlich aus dem versionierten Manifest.
- `deploy/install-agent-service.sh [--replace]`: installiert nur den Agenten als systemd-Benutzerdienst (für Maschinen ohne DevDeck-Server); beendet auf Wunsch von Hand gestartete Agent-Prozesse.
- Agent-Update wird verifiziert: nach dem Build startet der neue Code probeweise (`index.js status`, meldet Version/Node); bei Fehlern Abbruch VOR dem Neustart mit Begründung. Der Agent meldet im
  Heartbeat Commit, Node-Version und Startdatei (Agent 0.7.0, Migration v12); die Maschinen-Liste zeigt sie und warnt „Update nicht angekommen“, wenn die laufende Version älter ist als die gebaute.
  Ein Versionswechsel stößt für alle Workspaces der Maschine eine neue Prüfung an (frische Fakten für die Architektur-Karte).
- **Architektur-Karte** auf der Projekt-Übersicht (weißes Feld, volle Breite): Entwicklung → GitHub → Betrieb/Hosting → Datenbank, darunter externe Dienste (Mail, Telegram, LLM, Karten, Newsletter, Zahlung …)
  mit Beschreibungen und beschrifteten Pfeilen. Quellen: automatische Erkennung (Agent 0.6.0 sammelt Variablen-NAMEN, bereinigte Hostnamen ohne Zugangsdaten, Abhängigkeiten, Hosting-Dateien, SQLite-Größen; Server kennt Maschinen/Repo/Secret-Namen),
  versioniertes Manifest `.devdeck/architecture.yaml` (Claude Code pflegt es über `RULES.md`) und manuelle Anpassungen (bearbeiten/ausblenden/wiederherstellen, + Komponente/Beziehung). Migration v11.
  Der Agent schließt nur generierte Dateien aus `.git` aus (`.devdeck/architecture.yaml` bleibt versionierbar; alte pauschale `.devdeck/`-Zeile wird migriert).
- Workspace-Status erklärbar: Die Ergebnisse der letzten Prüfung (Readiness-Checks + Git-Zustand) werden gespeichert (Migration v10); Klick auf den Status zeigt
  jeden Prüfpunkt mit Begründung. Neuer Knopf **Prüfen** (read-only). Automatische Prüfung beim Registrieren/Ändern und für nie geprüfte Workspaces beim Heartbeat.
  Neuer Prüfpunkt „GitHub“ (unveröffentlichte Commits / neuer Remote-Stand). Agent 0.5.0.
- Workspaces bearbeiten (Pfad, Maschine, Branch, Repository; mit Audit) und entfernen (nur die Registrierung, nie Dateien; Maintainer; wartende Aufträge werden verworfen).
  Der Pfad wird beim Registrieren/Bearbeiten gegen den Workspace-Root der Maschine geprüft (Windows und Linux, Windows ohne Groß-/Kleinschreibung); der Dialog zeigt den Root
  und schlägt ihn als Pfad vor. Gleicher Pfad auf verschiedenen Maschinen ist erlaubt.

### Changed
- Doku: Hilfe („Die Tabs eines Projekts“, inkl. Erklärung der Entscheidungen), README (Project tabs) und Anleitung beschreiben alle Projekt-Tabs; Rollentabelle der Hilfe an die tatsächlichen Rechte angepasst (Tasks: maintainer).
- Doku: README (Abschnitt „Deploying a project that runs on a machine“), Hilfe-Seite (Fehlersuche beim Deploy) und ROADMAP zum Workspace-Deploy ergänzt.
- Hilfe: Abschnitt „Maschinen & Agent“ erklärt jetzt genau, was „Agent updaten“, „Root ändern“ und „Widerrufen“ tun („Widerrufen“ löscht nichts, es sperrt nur den Agenten dauerhaft – daher unverändert benannt).
- Architektur-Karte steht auf der Projekt-Übersicht jetzt unten; Kennzahlen, Projektinfo und letzte Sessions bleiben oben.

### Fixed
- Sync-Log: Aufträge mit identischem Zeitstempel erscheinen jetzt in stabiler Reihenfolge (neueste zuerst); ein davon abhängiger Test war unter Linux gelegentlich rot.
- Sync/Deploy-Abbruch „lokale Änderungen“ nennt jetzt die betroffenen Dateien (bis zu fünf) direkt in der Meldung und im Sync-Log.
- Agent-Update scheiterte mit „GIT_UNREACHABLE … no such ref was fetched“, wenn der Ordner auf einem längst gemergten Feature-Branch stand, dessen Remote nach dem Merge gelöscht wurde
  (`git pull` am Branch). Das Agent-Update holt jetzt wie das Server-Update `origin/main` und wechselt bei Bedarf per Fast-Forward auf `main` (`DEVDECK_UPDATE_BRANCH`); schlägt Build oder Probelauf
  fehl, wird der alte Stand wiederhergestellt. Das Server-Update erkennt außerdem „Code auf der Platte ist neuer als der laufende Prozess“ (z. B. von Hand gepullt) und baut/startet dann trotzdem neu.
- Hängende Agent-Aufträge: „running“-Aufträge ohne Ergebnis (Agent beendet/neu gestartet) blockierten dauerhaft u. a. das automatische Update („busy“); sie werden nach 30 Minuten als fehlgeschlagen abgeschlossen.
- Dauer-„warning“: Ein fehlendes `.devdeck/workspace.yaml` ist nur noch ein optionaler Hinweis (OK), eine fehlende `.env` zählt nur, wenn das Manifest eine Projektion
  verlangt; die Kontext-Warnung entfällt, weil Sync den Kontext jetzt schreibt. Unter Windows wurde `npm` fälschlich als „nicht gefunden“ gemeldet (`.cmd` braucht eine Shell);
  Python wird auch als `python` erkannt. Fehlt der Workspace-Ordner, meldet der Agent „blocked – Provision ausführen“ statt nur zu scheitern (Status blieb „unknown“).
- Provision nutzt ohne eigenes Repository am Workspace Repository und Standard-Branch des Projekts (vorher: „Kein Git-Repository und kein repo_remote“).
- Import: gleiche Secret-Namen in `.env` und `credentials.md` ließen den Import am Unique-Constraint scheitern → doppelte Einträge werden zusammengefasst
  (`.env.<umgebung>`, `.env.local`, `.env` vor `credentials.md`). Dateisuche unabhängig von Groß-/Kleinschreibung (Changelog/History, Roadmap/TODO/Backlog,
  credentials/zugangsdaten) auch in `docs/`; Roadmaps ohne Checkboxen werden als Listen gelesen (✅/durchgestrichen/„Erledigt“ = erledigt);
  Changelogs mit Datumsüberschriften (auch `23.10.2026`) und Absätzen werden erkannt. Die Vorschau zeigt Beispiele und bei Nichtfinden die vorhandenen Textdateien.
- Import: Der Server prüft die Agent-Version und meldet bei zu alten Agents (< 0.4.0) verständlich, wie man sie aktualisiert, statt dass der Agent
  „Aktion nicht erlaubt: project.import“ zurückgibt. Agent-Update setzt eine versehentlich geänderte `package-lock.json` zurück (statt „GIT_DIRTY“) und
  fällt bei fehlgeschlagenem `npm ci` auf `npm install` zurück.
- Import-/Secret-Dialog und Hilfe erklären jetzt development, staging und production.
- Workspace-Sync/-Provision schrieben den generierten Kontext nicht nach `.devdeck/`; jetzt gemeinsam über `writeContextFiles`. Generierte Dateien werden lokal per
  `.git/info/exclude` ignoriert, damit der Workspace nicht „dirty“ wird und der nächste Sync nicht abbricht. Command-Ergebnisse enthalten keine Dateiinhalte mehr.
- Agent: Verbindungsfehler (Enrollment, Heartbeat, …) nennen jetzt URL und Ursache („Verbindung abgelehnt“, „Zeitüberschreitung – Firewall/anderes Netzwerk?“,
  „Hostname nicht auflösbar“) statt „This operation was aborted“; Enrollment gibt nach 15 s auf statt nach 40 s.

### Added
- **Import per Knopf:** Workspaces → „Importieren“ (Aktion `project.import`, Agent 0.4.0): liest CHANGELOG.md, ROADMAP/TODO.md, .env/credentials.md im Workspace,
  Vorschau ohne Secret-Werte, danach Import (idempotent; Secrets verschlüsselt im Vault; Audit ohne Werte). Parser liegen jetzt in `@devdeck/shared`.
- **Coding-Regeln für Claude Code:** Der Server erzeugt `RULES.md`; der Agent installiert sie unversioniert als `.claude/rules/devdeck.md`
  (Kontext lesen, nach jeder Änderung bauen/testen/pushen). Marker `<!-- devdeck:rules-included -->` in `CLAUDE.md` schaltet das ab.
- „Alle Agents mit updaten“: Das Server-Update reiht (Häkchen, Standard an) `agent.update` für alle online befindlichen Agents ab 0.2.0 ein.
  Agent-Update nutzt `npm ci` (fasst die Lockfile nicht an) und startet nur neu, wenn sich der Code wirklich geändert hat
  (auch auf dem Server-Rechner, wo der Code bereits aktuell ist). Selbst-Update-Fähigkeit (`agent_can_self_update`) statt „veraltet“ entscheidet über den Knopf.
- Automatisches Update (optional, standardmäßig aus): einmal pro Nacht zur gewählten Stunde, nur bei neuem `main`, sauberem Ordner und
  ohne laufende Agent-Aufträge; Einstellungen und „Letztes Update“ auf der System-Seite (Tabelle `settings`, Migration v9).
- Auto-Merge für Pull Requests in GitHub aktiviert; `CLAUDE.md` nutzt `gh pr merge --auto`.
- Server-Update per Knopfdruck (**System → Server aktualisieren**, nur Admin): Backup, `git fetch` + Fast-Forward auf `main`
  (`DEVDECK_UPDATE_BRANCH`), `npm ci`, Build, Neustart über systemd (Exit 75); bei Fehlern automatische Rückabwicklung auf den
  vorherigen Stand. Bricht bei lokalen Änderungen am Server-Checkout ab. Routen `GET /api/system/version`, `GET|POST /api/system/update`.
- `CLAUDE.md`: Claude Code hält GitHub nach jeder Code-Anpassung aktuell (Branch, PR, CI, Merge).
- Dokumentation des Workflows „Am PC entwickeln → GitHub → Server aktualisieren“ (Hilfe-Seite, ANLEITUNG §9, README).
- Claude-Code-Sessions werden automatisch erfasst: Der Agent (`sessionScanner.ts`, alle 5 Minuten, Abschalten mit
  `DEVDECK_SCAN_SESSIONS=0`) liest `~/.claude/projects/…/*.jsonl` (CLI und Desktop) für die registrierten Workspaces
  und meldet NUR Metadaten (Titel, Zeiten, Branch, PR-Link, Nachrichtenanzahl) an `POST /api/agent/sessions/import`.
  Prompts und Gespräche verlassen den Rechner nie. Sessions-Tab zeigt Quelle, Branch, PR; Übersicht zeigt „Zuletzt aktiv“.
  Migration v8, Agent-Version 0.3.0 (ältere Agenten gelten als veraltet).
- `devdeck import changelog|tasks|secrets|all`: übernimmt vorhandene `CHANGELOG.md`, `ROADMAP.md`/`TODO.md` (Checkboxen)
  und `.env`/`credentials.md` in ein DevDeck-Projekt. Standardmäßig nur Vorschau (`--apply` schreibt), idempotent,
  Secret-Werte werden nie ausgegeben. `--create` erzeugt eine `ROADMAP.md` aus den DevDeck-Tasks. Changelog-Einträge
  behalten ihr Datum (`date` in `POST …/changelog`), erledigt angelegte Tasks bekommen `closed_at`.
- `ROADMAP.md` für DevDeck selbst.
- Phase J (Start): Konnektor-Interface (`services/connectors/`) und erster Konnektor GitHub (Token- und Repo-Check,
  offene Issues/PRs). Credentials bleiben im Vault (Referenz auf ein Projekt-Secret, `secret.use` nötig),
  neue Tabelle `project_connectors` (Migration v7), Routen `routes/connectors.ts`, Projekt-Tab „Integrationen“.
- Phase H (Basis): `devdeck` CLI (`packages/cli`, ohne zusätzliche Dependencies): `login/logout/whoami`, `status`,
  `sync`, `context`, `session start|finish`, `handover import`, `task|changelog|decision add`, `secret list`
  (nur Metadaten) und `env run -- <cmd>` (Secrets nur in die Prozess-Umgebung des Kindprozesses).
  `devdeck claude|codex`: Launcher mit Kontext-Refresh, automatischer Coding Session und Allowlist (nur claude/codex).
  Projekterkennung über `--project`, `.devdeck/project.json` oder den registrierten Workspace-Pfad.
- Phase E (Rest): Decisions, Changelog, Known Issues und Verlauf (Routen `knowledge.ts`, neue Projekt-Tabs).
  Akzeptierte Entscheidungen und offene Known Issues fließen in `.devdeck/CONTEXT.md` / `CURRENT_STATE.md` ein.
- Phase I: System-Backups (`services/backups.ts`, `routes/backups.ts`, UI „Backups"): konsistente Snapshots von
  `devdeck.db` und `vault.db` als Verzeichnis-Bundle mit Manifest + SHA-256, Verifikation, Retention
  (7 täglich + 4 wöchentlich), täglicher Scheduler (`DEVDECK_BACKUP_INTERVAL_HOURS`, `DEVDECK_BACKUP_TARGET`).
  Der Vault-Key wird nie mitgesichert. Restore ausschließlich interaktiv im Terminal
  (`node packages/server/dist/restore.js <ordner>`, Zeitstempel + `RESTORE` tippen) – kein API-/UI-Restore.
- Context-Builder (`services/contextBuilder.ts`) und Agent-Endpunkt `POST /api/agent/context/write`:
  `.devdeck/CONTEXT.md|CURRENT_STATE.md|CHANGELOG_RECENT.md|SECRETS.md` werden live aus SQLite erzeugt.
- Secret-Projektion für Agenten: `POST /api/agent/secrets/fetch` (autorisierte `.env`-/Datei-Werte)
  und `POST /api/agent/secrets/check` (Versions-Metadaten ohne Entschlüsselung).
- DevDeck Vault vollständig verdrahtet: Secret-Werte werden jetzt tatsächlich AES-256-GCM-verschlüsselt
  gespeichert und bei `secret.reveal`-Capability entschlüsselt angezeigt (auditiert).
- Komplett neu gestaltete Web-UI (Sidebar/Topbar-Shell, Light/Dark-Theme, Modals, Toasts) mit neuen
  Ansichten für Tasks, Coding Sessions/Handover, Secrets, Workspaces, Maschinen, Benutzerverwaltung.
- Neue Hilfe-Seite in der Web-UI mit Erklärung aller Funktionen.
- Tests: `vault.test.ts`, `agentContext.test.ts`, `sessionsHandover.test.ts`.

### Fixed
- `start.sh` bootstrapte beim ersten Start keinen Admin (Env-Variablen wurden nie exportiert).
- Secret-Anlage schlug immer mit `NOT NULL constraint failed: secret_grants.created_at` fehl.
- Secrets- und Sessions-Listen schlugen mit `datatype mismatch` fehl (fehlender Parameter-Spread).
- Handover-Erstellung/-Liste schlug immer fehl (Spalte `handovers.created_by` fehlte im Schema).
- Agent rief für `workspace.sync` einen nicht existierenden Context-Endpunkt auf.

## Version 1.0.0 - 2026-10-06

### Added
- DevDeck Server Architecture (Linux VM, Web UI/API, SQLite)
- DevDeck Agent CLI mit Befehlen: enroll, status, start
- Machine Enrollment Tokens (einmalig, abläuft, gehasht)
- Machine Revocation (Admin/Projekt-Berechtigung)
- API-Endpunkte für Tasks, Sessions, Handovers, Vault/Secrets
- Coding Session Tracking mit strukturierten Handovers
- Workspace Synchronisation und Provisionierung
- Backup-System (System- und Projekt-Backups)
- Audit Logging für alle kritischen Operationen
- Erweitertes Authentifizierungs- und Berechtigungssystem
- Health-Check-Endpoint `/health`

### Changed
- Initialer Admin wird ausschließlich über `DEVDECK_ADMIN_EMAIL`/`DEVDECK_ADMIN_PASSWORD` angelegt (keine Defaults)
- Verbesserter Vault/Secret-Management mit Metadaten-Only-Exposure
- Rollen-basierter Zugriff (owner, maintainer, developer, viewer)

### Fixed
- Keine Secret-Werte in Context, Logs oder Changelogs
- Sichere Passwort-Hashing-Policy
