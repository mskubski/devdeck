# Changelog

## Unreleased - 2026-10-23

### Added
- Workspaces bearbeiten (Pfad, Maschine, Branch, Repository; mit Audit) und entfernen (nur die Registrierung, nie Dateien; Maintainer; wartende Aufträge werden verworfen).
  Der Pfad wird beim Registrieren/Bearbeiten gegen den Workspace-Root der Maschine geprüft (Windows und Linux, Windows ohne Groß-/Kleinschreibung); der Dialog zeigt den Root
  und schlägt ihn als Pfad vor. Gleicher Pfad auf verschiedenen Maschinen ist erlaubt.

### Fixed
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
