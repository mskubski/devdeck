# Changelog

## Unreleased - 2026-10-08

### Added
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
