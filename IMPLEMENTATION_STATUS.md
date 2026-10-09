# DevDeck – IMPLEMENTATION_STATUS.md

Aktueller Umsetzungsstand der Phasen gemäß `IMPLEMENTATION_PLAN.md` §14.
Aktualisiert nach jeder Phase (Code → Tests → Typecheck → Dokumentation).

## Gesamtstatus

| Phase | Inhalt | Status |
|---|---|---|
| A | Foundation: Repo, DB-Schema, Auth, Users, Projects, Memberships, Audit, WebUI-Login | ✅ abgeschlossen |
| B | Agent-Protokoll: Machine Registry, Enrollment, Heartbeat, Command-Queue, Agent-Gerüst | ✅ abgeschlossen |
| C | Workspace Registry, workspace.yaml, Workspace Status, Readiness | ✅ abgeschlossen |
| D | Provision Workspace, Sync Workspace, Dependencies | ✅ abgeschlossen |
| E | Tasks ✅ · Decisions/Changelog/Known Issues/History | ⏳ Tasks fertig, Rest bewusst zurückgestellt (siehe unten) |
| F | Coding Sessions ✅ · .devdeck Context ✅ · Handovers ✅ | ✅ abgeschlossen |
| G | DevDeck Vault: Metadata, Values, Files, Permissions, Projektion | ✅ abgeschlossen |
| H | DevDeck CLI, Claude-Launcher, Codex-Launcher | ⬜ kein Quellcode vorhanden |
| I | Backups, Restore, Retention | ⬜ nur Datenmodell, keine Implementierung |
| J | Service-Integrationen (Konnektoren) | ⬜ |

## Review & Vervollständigung – 2026-10-08

Ein vollständiger Code-Review von Backend, Agent und Web-UI ergab, dass Phase C/D
(Workspace-Registry, Readiness, Provision/Sync) im `packages/agent`-Code bereits mit hoher
Qualität umgesetzt, aber nie committed und dieser Status-Doc nie nachgeführt worden war.
Zusätzlich fehlten drei vom Agenten bereits erwartete Server-Endpunkte vollständig, wodurch
Context-Erzeugung und Secret-Projektion faktisch nie funktioniert hatten. Diese Lücken wurden
geschlossen:

**Neu implementiert / verdrahtet:**

- `POST /api/agent/context/write` – Context-Builder (`services/contextBuilder.ts`) erzeugt
  `CONTEXT.md`/`CURRENT_STATE.md`/`CHANGELOG_RECENT.md`/`SECRETS.md` live aus SQLite (Phase F).
- `POST /api/agent/secrets/fetch` + `POST /api/agent/secrets/check` – autorisierte
  `.env`-/Secret-File-Projektion für den Maschinenbesitzer (`vault/projection.ts`, Phase G).
- `VaultService` (AES-256-GCM, war bereits fertig) ist jetzt tatsächlich in `ctx.vault`
  instanziiert und in `routes/vault.ts` verdrahtet: Werte werden beim Setzen verschlüsselt
  gespeichert und bei `secret.reveal`-Capability entschlüsselt zurückgegeben (auditiert).
- Web-UI vollständig neu aufgebaut (Sidebar/Topbar-Shell, Light/Dark-Theme, Modals/Toasts,
  weiterhin Vanilla-JS/CSS ohne Framework/Build-Step gemäß Entscheidung A8) mit Ansichten für
  Tasks, Coding Sessions/Handover, Secrets/Vault, Maschinen, Workspaces, Benutzerverwaltung
  und einer neuen Hilfe-Seite.

**Dabei gefundene und behobene Bugs (jeweils mit Test abgesichert):**

- `start.sh` druckte feste Admin-Login-Daten, setzte sie aber nie als
  `DEVDECK_ADMIN_EMAIL`/`DEVDECK_ADMIN_PASSWORD` – ein echter erster Start legte dadurch
  **keinen** Admin an.
- `routes/vault.ts`: `POST .../secrets` beim Anlegen fehlte die Spalte `created_at` im
  `secret_grants`-Insert → jede Secret-Anlage schlug mit `NOT NULL constraint failed` fehl.
  Zusätzlich verwendete der Grant `subject_type = 'member'`, den `secretCapabilitiesFor`
  nie auswertet (jetzt `'user'`).
- `routes/vault.ts` und `routes/sessions.ts`: Listen-Queries riefen `db.all(query, params)`
  statt `db.all(query, ...params)` auf – das Array wurde dadurch als ein einzelner,
  JSON-serialisierter Parameter gebunden → `datatype mismatch` bei jeder Secrets-/Sessions-Liste.
- Schema: Tabelle `handovers` hatte nie die Spalte `created_by`, obwohl
  `routes/sessions.ts` sie seit Einführung des Handover-Endpunkts voraussetzt – jeder
  Handover-Create/-List-Aufruf schlug fehl. Migration v5 ergänzt die Spalte.
- `packages/agent/src/actions/workspaceSync.ts` rief `/api/agent/context/refresh` auf,
  obwohl der Server (und alle anderen Call-Sites) `/api/agent/context/write` erwartet.

**Bewusst zurückgestellt** (dokumentiert in der Hilfe-Seite der Web-UI, nicht stillschweigend
weggelassen): DevDeck CLI, Backups/Restore, eigene Decisions/Changelog/Known-Issues-Verwaltung,
Service-Integrationen. Diese sind mehrwöchige Einzelvorhaben und wurden nicht halbfertig
begonnen.

Tests: 83/83 grün (`npm test`), `tsc -b` sauber. Neue Tests:
`packages/server/test/vault.test.ts`, `agentContext.test.ts`, `sessionsHandover.test.ts`.

## Phase A – abgeschlossen

**Umgesetzt:**

- Monorepo (npm Workspaces): `@devdeck/shared`, `@devdeck/server`, `@devdeck/agent`, `@devdeck/cli`
- TypeScript-Strikt-Konfiguration, `tsc -b` als Build & Typecheck, Vitest als Testrunner
- SQLite-Schema (3 Migrationen, `PRAGMA user_version`) hinter Wrapper `db/database.ts`
  (`node:sqlite` isoliert in einer Datei – Entscheidung A2)
- Authentication: scrypt-Passwort-Hashing (N=2^15), Session-Cookies (httpOnly/SameSite=Strict,
  nur SHA-256-Hashes in DB), Bearer-Token für CLI, serverseitiger Widerruf
- Authorization: Systemrollen vs. Projektrollen, serverseitige Prüfung in jeder Route,
  letzter-Owner-/letzter-Admin-Schutz
- Users, Projekte, Memberships (inkl. Audit-Einträgen)
- Audit-Log-Service mit Redaktions-Schlüssel (keine Secret-Werte)
- Statische Web UI (Login, Projekte, Mitglieder, Audit-View)
- Zentraler Fehler-Handler mit DevDeck-Error-Codes (`AppError`)
- Vault-Kern (`VaultService`, AES-256-GCM, separate `vault.db`, Keyfile 0600) – Basis für Phase G

**Tests:** `packages/server/test/auth.test.ts` (9), `packages/server/test/authz.test.ts` (10)
→ **19/19 grün**, `tsc -b` ohne Fehler.

**Dokumentierte Entscheidungen/Abweichungen dieser Phase:**

- scrypt-Parameter N=2^15 (statt ursprüng geplant 2^20, das 1 GiB Speicher pro Hash bräuchte):
  OWASP-konform, praktikabel auf kleinen VMs (PLAN A4 aktualisiert).
- Vitest 5: `poolOptions` entfernt; SQLite-Experimental-Warnung wird statt über `execArgv`
  lokal vor Import gedämpft (`db/warningGuard.ts`).
- Datei `STRUKTUR (1).md` → `STRUKTUR.md` umbenannt (Konflikt K1 im PLAN).

## Phase B – abgeschlossen

**Umgesetzt:**

- Machine Registry: `GET /api/machines`, `GET /api/machines/:id`,
  `DELETE /api/machines/:id` (Widerruf mit `confirm`, setzt ausstehende Commands auf `expired`)
- Enrollment: einmalige, ablaufende, gehashte Enrollment-Tokens; `POST /api/agent/enroll`
  (Einmal-Verbrauch, Audit `machine.enroll` inkl. `denied`-Fällen)
- Agent-Auth: Maschinen-Token (SHA-256-gehasht, widerrufbar) über Bearer
- Heartbeat (`POST /api/agent/heartbeat`): `last_seen_at`, `agent_status=online`,
  Registrierung/Aktualisierung projektbezogener Workspaces
- Command-Queue (`services/provisioning.ts`): `enqueue`, atomarer Long-Poll-Claim
  (queued → running), idempotente Resultat-Speicherung, Ablauf-/Offline-Sweeps
  (Hintergrundintervall im Server-Start)
- Workspace-Status-Report + Git-Metadaten, Session-State-Meldung (Basis für Phase F)
- Agent-Paket: `config` (agent.json, 0600), `ServerClient`, `startHeartbeat`, `startWorker`,
  Local API (nur 127.0.0.1, Local-Token), CLI-Einstieg (`enroll|start|status`),
  Action-Registry mit erzwungener Shared-Allowlist (**keine Remote-Shell**)

**Tests:** `packages/server/test/agent.test.ts` (17) → Suite gesamt **36/36 grün**, `tsc -b` sauber.

---
