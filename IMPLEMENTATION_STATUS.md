# DevDeck – IMPLEMENTATION_STATUS.md

Aktueller Umsetzungsstand der Phasen gemäß `IMPLEMENTATION_PLAN.md` §14.
Aktualisiert nach jeder Phase (Code → Tests → Typecheck → Dokumentation).

## Gesamtstatus

| Phase | Inhalt | Status |
|---|---|---|
| A | Foundation: Repo, DB-Schema, Auth, Users, Projects, Memberships, Audit, WebUI-Login | ✅ abgeschlossen |
| B | Agent-Protokoll: Machine Registry, Enrollment, Heartbeat, Command-Queue, Agent-Gerüst | ⏳ als Nächstes |
| C | Workspace Registry, workspace.yaml, Workspace Status, Readiness | ⬜ |
| D | Provision Workspace, Sync Workspace, Dependencies | ⬜ |
| E | Tasks, Decisions, Changelog, History, Known Issues | ⬜ |
| F | Coding Sessions, .devdeck Context, Handovers | ⬜ |
| G | DevDeck Vault: Metadata, Values, Files, Permissions, Projektion (Kern-Vault steht) | ⬜ |
| H | DevDeck CLI, Claude-Launcher, Codex-Launcher | ⬜ |
| I | Backups, Restore, Retention | ⬜ |
| J | Service-Integrationen (Konnektoren) | ⬜ |

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

---
