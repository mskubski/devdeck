# DevDeck – IMPLEMENTATION_PLAN

Status: aktiv, Stand 2026-10-05
Verfasst von: Lead Software Architect / Senior Full-Stack Developer

Dieses Dokument ist der verbindliche Umsetzungsplan für die Implementierung von **DevDeck**
gemäß `DEVDECK_v5.md` (Priorität 1), `STRUKTUR.md` (Priorität 2), `README.md` (Priorität 3).

---

## 0. Dokumentenlage und dokumentierte Konflikte

### 0.1 Gelesene Source-of-Truth-Dateien

| Datei | Rolle |
|---|---|
| `DEVDECK_v5.md` | Verbindliche Spezifikation, höchste Priorität |
| `STRUKTUR.md` | Technische Systemstruktur, Priorität 2 |
| `README.md` | Produktbeschreibung/Zielbild, Priorität 3 |

### 0.2 Festgestellte Konflikte / Abweichungen und ihre Auflösung

Keine der drei Dateien widerspricht sich in inhaltlichen Architekturkernpunkten.
Folgende Abweichungen wurden festgehalten und aufgelöst (niemals stillschweigend):

| # | Befund | Auflösung |
|---|---|---|
| K1 | Die Aufgabenstellung referenziert `STRUKTUR.md`, im Repository lag `STRUKTUR (1).md` (Download-Doppelname). | Datei wurde zu `STRUKTUR.md` umbenannt, damit die Source-of-Truth eindeutig referenzierbar ist. Inhalt unverändert. |
| K2 | `README.md` (Roadmap Phase 8) nennt Service-Integrationen generisch, `DEVDECK_v5.md` nennt eine konkrete Liste (GitHub, GitLab, Supabase, Vercel, Brevo, Apple, Google Play, IONOS). | Priorität 1 gewinnt: Die konkrete Liste gilt als Zielmenge; README-Aussage wird als „Reihenfolge nach Bedarf" gelesen. |
| K3 | `README.md` kennzeichnet sich selbst als „Konzept- und Architekturphase, nicht implementiert". | Gilt bis zum Abschluss dieser Implementierung; Status-Abschnitt des README wird aktualisiert. |
| K4 | `DEVDECK_v5.md` §5 listet `devdeck secret list`, ohne zu klären, ob er Werte zeigt. Security-Regeln verbieten Secret Values in Kontext/Logs. | `devdeck secret list` zeigt ausschließlich Metadaten. Werte niemals. `secret.reveal` nur mit Capability und Audit-Eintrag. |
| K5 | Keine Datei legt Stack für DevDeck *selbst* fest (Node „24" im Manifest-Beispiel = Projekt WebApp). | Entscheidung A1: TypeScript auf Node.js ≥ 22.5. |
| K6 | „DevDeck Workspace" teils Komponentenname, teils lokaler Arbeitsordner. | Durchgängig: **Local Workspace** = lokaler Arbeitsordner inkl. `.devdeck/`. „DevDeck Workspace" bleibt Komponentenname der Spezifikation. |

### 0.3 Namenskonvention

Durchgängig nur **DevDeck**. Alte Bezeichnungen (`DEV COCKPIT`, `DevCockpit`, `Cockpit`,
`.devcockpit`) tauchen nur noch als historische Namensänderungserwähnung in
`DEVDECK_v5.md` auf und werden in Code, CLI, Pfaden und UI nicht verwendet.
Lokaler Projektordner: `.devdeck/`.

---

## 1. Aktuelle Repository-Struktur (Ist-Zustand der Analyse)

```text
/path/to/devdeck
├── DEVDECK_v5.md          (Spezifikation, 941 Zeilen)
├── README.md              (Produktbeschreibung, 708 Zeilen)
└── STRUKTUR.md            (Systemstruktur, 1037 Zeilen; ehem. "STRUKTUR (1).md")
```

Befunde:

- **Kein Quellcode** vorhanden (keine Quelldateien irgendeiner Sprache).
- **Kein Git-Repository** initialisiert (wird mit dieser Umsetzung initialisiert).
- **Keine** `.gitignore`, **keine** CI, **keine** bestehenden TODOs/halbfertigen Funktionen.
- **Keine** vorhandenen Frameworks/Libraries — Stack frei wählbar (A1–A12 unten).
- Umgebung: Node v22.23.3, npm 12.0.2, git 2.47.3, Linux.
- Verfügbar und geprüft: `node:sqlite` (DatabaseSync), `node:crypto` (scrypt, AES-256-GCM),
  npm-Registry erreichbar, `tar`/`sha256sum` vorhanden.

---

## 2. Geplante Zielarchitektur

```text
                        GitHub / GitLab  (Source of Truth: Sourcecode)
                              |
          +-------------------+-------------------+
          v                                       v
   Alice Rechner                          Bob Laptop
   Windows / macOS (/Linux)                 (beliebig)
   +-------------------+                     +-------------------+
   | DevDeck Agent     |                     | DevDeck Agent     |
   | DevDeck CLI       |                     | DevDeck CLI       |
   | Local Workspace   |                     | Local Workspace   |
   |  + .git           |                     |  + .git           |
   |  + .env (projiziert)                    |  + .env (projiziert)
   |  + .devdeck/      |                     |  + .devdeck/      |
   |  + Claude/Codex   |                     |  + Claude/Codex   |
   +---------+---------+                     +---------+---------+
             |  HTTPS, Agent-Token (pollbasiert, revokierbar)     |
             +-------------------+-------------------+
                                 v
                     DEVDECK SERVER (Linux VM)
                     +---------------------------+
                     | Web UI (statisch)         |
                     | REST API (/api)           |
                     | Auth + Authorization      |
                     | devdeck.db  (SQLite)      |  <- Projektwissen, Verwaltung
                     | vault/      (verschl.)    |  <- Secret Values + Secret Files
                     | Context Builder           |
                     | Audit Log                 |
                     | Backup Management         |
                     +-------------+-------------+
                                   |
                    +--------------+--------------+
                    v                             v
            Deployment Targets             Backup Target
        (Vercel/Linux/IONOS/Stores)      (unabhängiger Pfad/NAS)
```

Kernprinzipien (unverändert aus der Spezifikation):

```text
GitHub/GitLab      = Source of Truth für Sourcecode und Code-History
DevDeck SQLite     = Source of Truth für Projektwissen und administrative Daten
DevDeck Vault      = Source of Truth für Secret-Werte und Secret Files
Local Workspace    = lokale, reproduzierbare Arbeitskopie
Deployment Target  = laufende Anwendung
Backup Target      = unabhängige Sicherung
```

DevDeck ersetzt Git **nicht**; es orchestriert Git-Aktionen ausschließlich über den
lokalen Agenten und zeigt den Zustand an.

---

## 3. Technologie-Entscheidungen (Architektur-Entscheidungslog)

| # | Entscheidung | Begründung |
|---|---|---|
| A1 | **TypeScript (ESM) auf Node.js ≥ 22.5**, Monorepo mit npm Workspaces | Cross-Platform (Server Linux, Agent Win/macOS/Linux, CLI überall), eine Sprache für alle Komponenten, starke Typen für sicherheitsrelevante Protokolle, self-hosted ohne Zusatz-Runtime. Node 22.5+ wegen eingebautem `node:sqlite`. |
| A2 | **SQLite via `node:sqlite` (DatabaseSync)** hinter Wrapper `db/database.ts` | „Wenige Abhängigkeiten": kein Native-Build nötig (vs. better-sqlite3), eingebettet, self-hosted ideal. Risiko „experimental in Node 22" durch isolierte Wrapper-Schicht + Node-Pin beherrschbar. |
| A3 | **Express 5** als HTTP-Framework | Etabliert, minimal, keine Over-Engineering-Stacks. |
| A4 | **Passwort-Hashing: `scrypt`** (node:crypto, N=2²⁰, r=8, p=1, 32-Byte-Salt) | Eingebaut, für Passwörter konzipiert, keine Native-Dependency. |
| A5 | **Vault: AES-256-GCM** (node:crypto), 32-Byte-Master-Key, separate `vault.db` | Authentizierte Verschlüsselung, Standard, eingebaut. Key: Env `DEVDECK_VAULT_KEY` (base64) oder Keyfile `vault.key` (0600, auto-generiert + Audit-Hinweis). Key nie in DB/Logs/Backups. |
| A6 | **Opaque Bearer-Tokens**, in DB nur SHA-256-gehasht | Browser: Session-Cookie (httpOnly, SameSite=Strict). Agent: maschinenbezogenes, widerrufbares Token. Widerruf trivial, kein JWT-Secret nötig. |
| A7 | **Agent-Protokoll pollbasiert** (Agent initiiert alles) | NAT-freundlich (kein eingehender Port), nur ausgehendes HTTPS, kein WebSocket-Stack. |
| A8 | **Kein Frontend-Framework**: statische Web UI (vanilla JS) | Spezifikation verlangt Web UI, wenig Interaktionslast, keine UI-Build-Pipeline. |
| A9 | **YAML: `yaml` Paket v2** | Etabliert, einzige externe Parser-Dependency. |
| A10 | **Tests: `vitest`** + temporäre echte Git-Repos | TS-nativ; Fehler­szenarien (dirty, Conflict, fehlendes Tool) real testbar. |
| A11 | **Backup-Format: Verzeichnis-Bundle** (manifest.json + Dateien + SHA-256) | Restaurierbar ohne Zusatztools; unabhängiges Ziel (NAS) konfigurierbar; Restore von Anfang an im Datenmodell. |
| A12 | **Statische Qualität: `tsc --noEmit`** | Wenige Abhängigkeiten; Type-Safety trägt die statische Sicherheit. |
| A13 | **Secret-Capability-Vererbung**: Owner/Maintainer implizit alle Projekt-Capabilities, developer `metadata.read\|use`, viewer `metadata.read`; explizite Grants in `secret_grants` überschreiben | Einfach, vorhersagbar, serverseitig prüfbar, dokumentiert. |

Nicht gewählt bewusst: Redis/Queue, Microservices, JWT, Docker-Pflicht, Frontend-Framework —
die Spezifikation verlangt einfache, selbst-gehostete Architektur mit wenigen Abhängigkeiten
(Ein-Prozess-Server).

---

## 4. Server-Aufteilung (`packages/server`)

```text
packages/server/src/
├── index.ts                  # Einstieg: Config laden, DB öffnen, Server starten
├── app.ts                    # createApp(): Express-App komponieren (testbar ohne Listen)
├── config.ts                 # Env-Config (Port, Datenpfade, Session-TTL, Backup-Ziel, Vault-Key)
├── db/
│   ├── database.ts           # SQLite-Wrapper (node:sqlite) – EINZIGE Stelle mit node:sqlite
│   └── schema.ts             # Schema + Migrationen (PRAGMA user_version)
├── auth/
│   ├── passwords.ts          # scrypt hash/verify, timing-safe
│   ├── tokens.ts             # Token-Generierung + Hashung
│   ├── sessions.ts           # Browser-Session (anlegen/prüfen/löschen/Ablauf)
│   └── middleware.ts         # requireUser, requireSystemRole, requireProjectRole, requireSecretCap
├── vault/
│   ├── vault.ts              # Key-Management, AES-256-GCM, getrennte vault.db
│   └── projection.ts         # .env-Renderer + Secret-File-Entschlüsselung
├── services/
│   ├── audit.ts              # audit(...) – niemals Secret-Values
│   ├── knowledge.ts          # Tasks/Decisions/Changelog/Known Issues/History
│   ├── coding.ts             # Coding Sessions + Handover-Validierung
│   ├── contextBuilder.ts     # CONTEXT/CURRENT_STATE/CHANGELOG_RECENT/SECRETS.md
│   ├── readiness.ts          # Readiness-Aggregation
│   ├── provisioning.ts       # Provision-/Sync-Aufträge an Agenten (Command-Queue)
│   └── backups.ts            # System-Backup, Restore, Retention, Verifikation
├── routes/
│   ├── index.ts              # /api Router montieren
│   ├── auth.ts users.ts projects.ts machines.ts workspaces.ts
│   ├── knowledge.ts coding.ts secrets.ts agent.ts backups.ts audit.ts
└── webui/                    # statische Web UI (login + dashboard)
```

Verantwortung: Der Server besitzt **Wissen, Verwaltung, Rechte, Vault, Backups**.
Er führt **keine** Entwicklung auf eigener Codekopie aus und bietet **keine** Remote-Shell.

## 5. Agent-Aufteilung (`packages/agent`)

```text
packages/agent/src/
├── index.ts                  # Einstieg: Config, Enrollment, Heartbeat+Worker
├── config.ts                 # agent.json (Server-URL, Maschinen-Token, Workspace-Root)
├── client.ts                 # HTTP-Client zum Server (Token, Retry/Backoff)
├── localApi.ts               # localhost-only Status-API für CLI (127.0.0.1:7420)
├── heartbeat.ts              # Heartbeat-Loop
├── worker.ts                 # Command-Polling → ausführen → Result-Upload
├── actions/                  # EXAKTE ALLOWLIST (keine generische Shell!)
│   ├── index.ts              # Registry: name → Handler
│   ├── workspaceStatus.ts    # workspace.status
│   ├── workspaceSync.ts      # workspace.sync   (dirty → STOP)
│   ├── workspaceProvision.ts # workspace.provision (idempotent)
│   ├── contextRefresh.ts     # context.refresh
│   ├── envRefresh.ts         # env.refresh      (.env 0600)
│   ├── dependenciesInstall.ts# dependencies.install (npm ci laut Manifest)
│   ├── editorOpen.ts         # editor.open      (nur Allowlisted Editoren)
│   ├── terminalOpen.ts       # terminal.open    (nur im Workspace)
│   └── codingAgentStart.ts   # coding_agent.start (Claude Code / Codex im Workspace)
├── git.ts                    # git subprocess Helfer (status/clone/pull --ff-only)
├── manifest.ts               # workspace.yaml lesen/validieren
├── readiness.ts              # Toolchain-Prüfung → OK/WARNING/BLOCKED
├── env.ts                    # .env / Secret Files schreiben (0600)
└── tools.ts                  # Tool-Erkennung (git, node, npm, supabase, xcode, android…)
```

Sicherheitsregeln:

- Nur die Allowlist; **keine** generische Remote-Shell; kein `shell:true` mit User-Input;
  Pfade gegen Workspace-Root geprüft (kein `..`-Escape).
- Destruktive Aktionen → `CONFIRMATION_REQUIRED` und sauberer Abbruch.
- Agent-Token nur lokal in `agent.json` (0600), serverseitig widerrufbar.

## 6. CLI-Aufteilung (`packages/cli`)

```text
packages/cli/src/
├── index.ts                  # #!/usr/bin/env node, minimales eigenes Command-Routing
├── config.ts                 # ~/.devdeck/config.json (0600): Server-URL, Token
├── client.ts                 # Server-API-Client (Bearer) + Agent-Fallback (127.0.0.1:7420)
└── commands/
    ├── status.ts  sync.ts  context.ts  session.ts  handover.ts
    ├── changelog.ts  decision.ts  task.ts  secret.ts  envRun.ts
```

Bin-Name: `devdeck`. Wissens-APIs → direkt Server; Maschinen-Aktionen → bevorzugt lokaler
Agent (Fallback: Server-Auftrag an den Agenten).

---

## 7. Datenmodell

Haupt-DB `devdeck.db`; Secret-Werte ausschließlich in separater `vault/vault.db`
(verschlüsselte Blobs). Migrationen via `PRAGMA user_version`.

```sql
users(id, email UNIQUE, password_hash, system_role, display_name, created_at, updated_at, disabled)
sessions(id, user_id, token_hash UNIQUE, created_at, expires_at, revoked_at, user_agent, ip)
-- system_role: admin | developer   Projektrollen: owner | maintainer | developer | viewer

projects(id, name UNIQUE, slug UNIQUE, description, repo_remote, default_branch,
         created_at, updated_at, archived_at)
project_members(project_id, user_id, role, created_at, PRIMARY KEY(project_id,user_id))

machines(id, owner_user_id, name, platform, agent_version, agent_status, last_seen_at,
         token_hash, revoked_at, created_at)
enrollment_tokens(id, token_hash, created_by, project_id, expires_at, used_at, revoked_at)
workspaces(id, project_id, machine_id, owner_user_id, local_path, repo_remote, branch,
           status, last_git_commit, last_sync_at, last_context_sync_at, created_at, updated_at)
-- status: unknown | provisioning | ready | warning | blocked | offline

agent_commands(id, machine_id, action, payload_json, status, created_at, expires_at,
               started_at, finished_at, result_json, error, requested_by)
-- status: queued | running | done | failed | expired

tasks(id, project_id, title, description, status, priority, created_by,
      created_at, updated_at, closed_at)                     -- open|in_progress|done|cancelled
decisions(id, project_id, title, rationale, context, alternative, status, created_by,
          created_at, decided_at)                            -- proposed|accepted|superseded|rejected
changelog_entries(id, project_id, version, summary, body, source, session_id, created_by, created_at)
known_issues(id, project_id, title, description, status, severity, created_by, created_at, resolved_at)
git_metadata(id, project_id, workspace_id, commit_sha, branch, author, committed_at, message)

coding_sessions(id, project_id, workspace_id, machine_id, user_id, agent_name, started_at,
                ended_at, status, goal, handover_id, git_state_json)   -- open|closed
handovers(id, session_id, project_id, payload_json, validated_at, created_at)
open_items(id, session_id, project_id, item, status, created_at, resolved_at)

secrets(id, project_id, name, description, kind, environment, vault_reference, version,
        created_at, updated_at, created_by)   -- kind: env|file; environment: development|staging|production
secret_grants(id, secret_id, subject_type, subject_id, capability, created_at, created_by)
secret_targets(id, secret_id, target_path, file_mode)

backups(id, kind, target_path, manifest_path, status, created_at, finished_at, verified_at,
        size_bytes, checksum, created_by, error)             -- kind: system|project
backup_items(backup_id, relative_path, sha256, bytes)

audit_log(id, actor_type, actor_id, actor_label, action, project_id, machine_id,
          target_type, target_id, result, detail_json, ip, created_at)  -- result: success|failure|denied
```

---

## 8. API-Struktur (REST, JSON, `/api`)

Session/Bearer-authentifiziert:

```text
GET  /api/health                         (öffentlich)
POST /api/auth/login  |  /api/auth/logout  |  GET /api/auth/me

GET|POST /api/users, PATCH /api/users/:id                       (admin)
GET|POST /api/projects, GET /api/projects/:id                   (admin = anlegen)
GET|POST /api/projects/:id/members, DELETE .../members/:uid     (owner|maintainer)

GET|POST /api/projects/:id/tasks, PATCH /api/tasks/:id
GET|POST /api/projects/:id/decisions
GET|POST /api/projects/:id/changelog
GET|POST /api/projects/:id/known-issues
GET  /api/projects/:id/history            (konsolidiert)

GET  /api/projects/:id/machines, POST /api/machines/enrollment-tokens, DELETE /api/machines/:id
GET  /api/projects/:id/workspaces, GET /api/workspaces/:id, PATCH /api/workspaces/:id

POST /api/projects/:id/sessions, PATCH /api/sessions/:id/finish, GET /api/projects/:id/sessions
POST /api/projects/:id/handovers          (strukturiert, validiert)
GET  /api/projects/:id/context            (Context Builder → Markdown)
POST /api/projects/:id/sessions/:id/start-agent   (beauftragt coding_agent.start am Agenten)

GET|POST /api/projects/:id/secrets        (secret.metadata.read / secret.update)
POST /api/secrets/:id/reveal              (secret.reveal, audit-pflichtig)
POST /api/projects/:id/secrets/projection (secret.use → gerenderte .env-Map, audit)
DELETE /api/secrets/:id                   (secret.update, confirm)

GET|POST /api/projects/:id/backups, POST /api/backups/:id/restore (confirm),
POST /api/backups/:id/verify
GET  /api/audit                                              (admin bzw. projektweise Owner)
```

Nur Agent-Auth (Maschinen-Token):

```text
POST /api/agent/enroll            {enrollment_token, name, platform} -> {machine_id, machine_token}
POST /api/agent/heartbeat         {agent_version, workspaces[]}
GET  /api/agent/commands?wait=25  (Long-Poll, 204 wenn leer)
POST /api/agent/commands/:id/result
POST /api/agent/workspaces/:id/status
POST /api/agent/sessions/:id/state
POST /api/agent/secrets/fetch     {project, environment} -> projizierte Werte (audit-pflichtig)
```

---

## 9. Auth-Konzept

1. E-Mail + Passwort, `scrypt$N$r$p$salt$hash`, timing-safe Vergleich.
2. Session-Token (32 Byte) nur als SHA-256-Hash gespeichert; Cookie `dd_session`
   (httpOnly, SameSite=Strict), TTL Default 14 Tage, serverseitig widerrufbar.
3. Systemrolle (`admin|developer`) strikt getrennt von Projektrolle
   (`owner|maintainer|developer|viewer`); jede Projekt-Route prüft serverseitig die Membership.
4. Explizites Machine-Enrollment über einmaliges, ablaufendes Enrollment-Token
   (gehasht gespeichert) → maschinenbezogenes Token (gehasht, `revoked_at` widerrufbar).
5. Authorization **immer** serverseitig; UI/CLI sind nur Clients.
6. Destruktive Aktionen erzwingen `confirm: true` (Restore, Machine-Delete, Secret-Delete,
   Provision auf belegtem Workspace).
7. Secret-Capabilities gemäß A13; jedes `reveal`/`projection` erzeugt Audit-Einträge.

---

## 10. Vault-Konzept

```text
Metadaten (devdeck.db): name, description, kind, environment, version,
                        vault_reference = "v1:<key_id>:<row>"
Werte     (vault.db):   id, key_id, iv(12B), auth_tag(16B), ciphertext, updated_at
Dateien   (vault.db):   id, key_id, iv, auth_tag, ciphertext, sha256_plain, size_plain
```

- AES-256-GCM je Datensatz mit frischem 12-Byte-IV; AAD = `project:name:environment:version`
  (Verwechslungs-/Umsortierungsschutz).
- Master-Key: Env `DEVDECK_VAULT_KEY` (base64, 32 B) **oder** Keyfile `vault.key` (0600,
  auto-generiert mit Warnung + Audit). Key nie in DB, Logs, Audit, Kontext, Backup.
- `.env` wird **nie gespeichert**, nur frisch projiziert (0600); `.env`/Secret Files nie in Git
  (`.gitignore` wird beim Provisioning ergänzt).
- `SECRETS.md` ausschließlich Name/Description/Environment/Nutzung — nie Werte.
- `secret.reveal` Capability-gated + Audit; Werte laufen nur über TLS an autorisierte Agenten.

---

## 11. Agent-Protokoll (pollbasiert)

```text
1) Enrollment:  User erzeugt Enrollment-Token → Agent POST /api/agent/enroll
                ← {machine_id, machine_token}   (widerrufbar)
2) Heartbeat:   alle 30 s POST /api/agent/heartbeat → last_seen_at, agent_status=online
3) Kommandos:   alle ~5 s GET /api/agent/commands?wait=25 (Long-Poll, leer = 204)
4) Ergebnis:    POST /api/agent/commands/:id/result {status: done|failed, data?, error?}
5) Allowlist:   workspace.status | workspace.sync | workspace.provision | context.refresh |
                env.refresh | dependencies.install | editor.open | terminal.open |
                coding_agent.start
```

Strukturierte Fehler-Codes: `GIT_DIRTY`, `GIT_CONFLICT`, `GIT_UNREACHABLE`, `AGENT_OFFLINE`,
`TOOL_MISSING`, `DEP_FAILED`, `UNAUTHORIZED`, `CONFIRMATION_REQUIRED`, `MANIFEST_INVALID`,
`LOCKFILE_CHANGED`, `SECRET_UNAVAILABLE`. Commands laufen mit Ablaufzeit; Resultate
idempotent einmalig pro Command.

---

## 12. Workspace-Modell

- `.devdeck/workspace.yaml` wie spezifiziert (ohne Secrets); Parser validiert Pflichtfelder
  und ist für zusätzliche Runtime-/Tool-Typen ausgelegt (registry-basierte Tool-Checks).
- `.devdeck/` (generiert): `CONTEXT.md`, `CURRENT_STATE.md`, `CHANGELOG_RECENT.md`,
  `SECRETS.md` (nur Metadaten), `handover/`.
- **Provision** (idempotent): Clone → Toolchain → Dependencies → Secrets → `.env` →
  Secret Files → Context → Readiness → READY. Vorzustand je Schritt prüfen; belegter
  Workspace mit Änderungen → `CONFIRMATION_REQUIRED`.
- **Sync** (sicher): Git-Status → local changes → **STOP** (`GIT_DIRTY`, nichts anfassen) →
  `git fetch` + `pull --ff-only` (kein reset/stash/clean) → Dependency-Check (Lockfile-Hash) →
  Secret-Version-Check → Secret-File-Check → Context-Refresh → Readiness;
  Konflikt → `GIT_CONFLICT` + verständlicher Status.
- **Readiness** je Check `OK|WARNING|BLOCKED` (Git, Repository, Runtime-Tools, Dependencies,
  Secrets, Credentials, Context, plattformspezifisch: Xcode nur macOS, Android SDK → WARNING);
  Gesamt = max(BLOCKED > WARNING > READY).
- **Dependencies** nur lokal reproduziert (`npm ci`), nie kopiert.

---

## 13. Backup-Modell

```text
System-Backup (kind=system):
  <target>/devdeck-backups/<backup-id>/
  ├── manifest.json      (id, kind, schema_version, created_at, files[]+sha256, key_id)
  ├── devdeck.db         (atomare SQLite-Kopie)
  ├── vault.db           (nur verschlüsselte Blobs; Master-Key NICHT im Backup)
  └── server-config.json (nicht-sekret)
Restore: manifest+sha256 verifizieren → confirm:true → Sicherheits-Backup des aktuellen
         Zustands → Dateien ersetzen → Audit.
Retention: Keep-N + Alter (Tage); Pruning nur abgeschlossener Backups.
Projekt-Backups: Connector-Modell (Phase J, z. B. Supabase).
Backup-Ziel konfigurierbar und physisch getrennt (NAS/anderes Medium).
```

---

## 14. Implementierungsphasen & Abhängigkeiten

```text
PHASE A  Foundation: Repo-Setup, DB-Schema, Auth, Users, Projects, Memberships, Audit, WebUI-Login
PHASE B  Agent-Protokoll: Machine Registry, Enrollment, Heartbeat, Command-Queue, Agent-Gerüst  (braucht A)
PHASE C  Workspace Registry, workspace.yaml, Workspace Status, Readiness                        (braucht A,B)
PHASE D  Provision Workspace, Sync Workspace, Dependencies                                      (braucht C)
PHASE E  Tasks, Decisions, Changelog, History, Known Issues                                     (braucht A)
PHASE F  Coding Sessions, .devdeck Context, Handovers                                           (braucht C,D,E)
PHASE G  DevDeck Vault: Metadata, Values, Files, Permissions, Projektion                        (braucht A)
PHASE H  DevDeck CLI, Claude-Launcher, Codex-Launcher                                           (braucht B,D,F,G)
PHASE I  Backups, Restore, Retention                                                            (braucht A,G)
PHASE J  Service-Integrationen (Konnektoren, optional; Core bleibt ohne Integrationen nutzbar)
```

Nach jeder Phase: Code fertig → Tests → `tsc --noEmit` → Fehler beheben →
Dokumentation + `IMPLEMENTATION_STATUS.md` aktualisieren.

---

## 15. Teststrategie (Pflichtbereiche)

| Bereich | Testansatz |
|---|---|
| Authentication | Login, falsches Passwort, gesperrter User, Ablauf/-Widerruf der Session |
| Authorization | Systemrollen- und Projektrollen-Matrix, 403-Fälle |
| Project Permissions | Membership-CRUD, Owner/Maintainer/Developer/Viewer-Verhalten |
| Machine Enrollment | gültig, abgelaufen, wiederverwendet, widerrufen |
| Agent Authentication | Token-Prüfung, widerrufene Machine → 401, ungültiges Token |
| Workspace Sync | sauberer Sync, **dirty → STOP (Arbeitskopie unangetastet)**, Konflikt → `GIT_CONFLICT`, Remote weg → `GIT_UNREACHABLE` |
| Workspace Provision | frisch → READY, erneut → idempotent, fehlendes Tool → WARNING/BLOCKED |
| Vault Encryption | Roundtrip, falscher Key → Fehler, manipulierte Daten → Auth-Fehler, AAD-Mismatch |
| Secret Permissions | Capability-Matrix, `reveal` ohne Recht → denied + Audit |
| Secret Projection | `.env` korrekt, `SECRETS.md` **ohne** Werte |
| Backup/Restore | Backup → SHA-256 → Restore stellt Zustand her; korrupt → verweigert |
| Fehlerszenarien | Git nicht erreichbar, Agent offline, falsche Credentials, lokale Git Changes, Git Conflict, fehlendes Runtime-Tool, Dependency-Installation schlägt fehl |

---

## 16. Risiken

| # | Risiko | Mitigation |
|---|---|---|
| R1 | `node:sqlite` in Node 22 „experimental" | Wrapper-Schicht `db/database.ts`, Node ≥ 22.5 gepinnt, austauschbar |
| R2 | Master-Key-Verlust → Vault unwiederbringlich | Key nie in DB/Backup; Key-ID im Manifest; dokumentierte Außenführung; Restore prüft Key-ID |
| R3 | Agent-Maschine ohne Git/Node | Readiness + `TOOL_MISSING`, Provision prüft vorab |
| R4 | Sync zerstört lokale Arbeit | Harte Regel dirty → STOP; kein reset/stash/clean im Code; Tests |
| R5 | Secret-Leak über Logs/Kontext | Log-Redaktion, Renderer ohne Values, Tests „kein Value in SECRETS.md/Audit" |
| R6 | Scope (10 Phasen) | Inkrementell A→J, jede Phase grün; J als Konnektor-Stubs |
| R7 | Long-Poll/Command-Verlust | Command-Queue mit Status/Expiry, idempotente Resultate, Heartbeat |
| R8 | Windows-Pfade im Agenten | `node:path`, kein `shell:true` mit User-Input, plattformneutrale Logik |

---

## 17. Offene Architekturentscheidungen (getroffen)

| # | Frage | Entscheidung |
|---|---|---|
| O1 | Server-Framework | Express 5 (A3) |
| O2 | DB | `node:sqlite` hinter Wrapper (A2), Migrationen via `user_version` |
| O3 | Token-Stil | opaque + DB-Hash statt JWT (A6) |
| O4 | Push vs. Poll zum Agenten | Poll (A7) |
| O5 | Vault-Storage | separate `vault.db`, AES-256-GCM-Blobs (A5) |
| O6 | UI | statisches HTML/JS (A8) |
| O7 | DevDeck-eigene AI | außerhalb des Cores; AI=disabled muss alles funktionieren |
| O8 | System-Rollen | `admin`,`developer` gemäß Spezifikation, TEXT-Feld für spätere Erweiterung |
| O9 | Secret-Capability-Vererbung | Entscheidung A13 |

---

*Fortschritt: `IMPLEMENTATION_STATUS.md`.*
