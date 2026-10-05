# DevDeck v5

## Vision

**DevDeck** ist ein zentral selbst gehostetes Developer Control Plane und Projektgedächtnis für mehrere Entwickler, Projekte und Entwicklungsrechner.

Der frühere Arbeitsname `DEV COCKPIT` wird ab v5 vollständig durch **DevDeck** ersetzt.

```text
DevDeck Server
DevDeck Agent
DevDeck CLI
DevDeck Vault
DevDeck Workspace
.devdeck/
```

## Kernprinzipien

1. DevDeck läuft zentral auf einer Linux-VM.
2. Entwickler melden sich per Browser am DevDeck Server an.
3. Sourcecode bleibt in GitHub/GitLab die Source of Truth.
4. Der Code wird lokal auf Windows, macOS oder Linux bearbeitet.
5. Auf jedem Entwicklungsrechner läuft ein DevDeck Agent.
6. Claude Code, Codex und andere Coding Agents laufen direkt im lokalen Projektverzeichnis.
7. DevDeck verwaltet Projektwissen, History, Tasks, Decisions, Workspaces und Backups.
8. Secret-Werte liegen getrennt in einem verschlüsselten DevDeck Vault.
9. `.env` und Secret Files werden bei Bedarf in autorisierte lokale Workspaces projiziert.
10. Dependencies werden über Manifeste und Lockfiles reproduziert, nicht zwischen Rechnern kopiert.
11. DevDeck ist von Beginn an Multi-User und Multi-Project.
12. Eine eigene DevDeck AI ist optional und erst für eine spätere Roadmap vorgesehen.

---

# 1. Gesamtarchitektur

```text
                           GitHub / GitLab
                           SOURCE CODE
                                |
              +-----------------+-----------------+
              |                                   |
              v                                   v
       Alice Workstations                  Bob Laptop
       Windows / macOS / Linux                    |
              |                                   |
        DevDeck Agent                       DevDeck Agent
        DevDeck CLI                         DevDeck CLI
              |                                   |
              v                                   v
       WebApp Workspace                 MobileApp Workspace
              |                                   |
       Claude / Codex                       Claude / Codex
              |                                   |
              +-----------------+-----------------+
                                |
                                v
                       DEVDECK SERVER
                         Linux VM
              +--------------------------------+
              | Web UI / API                   |
              | Authentication                 |
              | Users / Permissions            |
              | SQLite                         |
              | DevDeck Vault                  |
              | Secret Files                   |
              | Tasks / Decisions              |
              | Changelog / History            |
              | Sessions / Handovers           |
              | Machine Registry               |
              | Workspace Registry             |
              | Backup Management              |
              | Audit Log                      |
              +---------------+----------------+
                              |
                 +------------+------------+
                 |                         |
                 v                         v
             Deployment                 Backups
       Vercel/Linux/IONOS          Local/NAS/other
                 |
                 v
       Supabase/Brevo/Stores
```

---

# 2. Benutzer und Projekte

Initiale Benutzer:

```text
admin@example.com
System Role: admin

WebApp
Project Role: owner
```

```text
bob@example.com
System Role: developer

MobileApp
Project Role: owner
```

Weitere Benutzer, Projekte und Geräte können später ohne Architekturänderung ergänzt werden.

Projektrollen:

```text
owner
maintainer
developer
viewer
```

Systemrolle und Projektrolle bleiben getrennt.

---

# 3. DevDeck Server

Standort:

```text
Linux VM
```

Aufgaben:

- Web UI
- API
- lokaler Benutzerlogin mit E-Mail/Passwort
- Benutzer- und Projektberechtigungen
- zentrale SQLite-Datenbank
- DevDeck Vault
- Secret Files
- Tasks
- Decisions
- vollständige Changelog-History
- Coding Sessions
- Handovers
- Machine Registry
- Workspace Registry
- Backup Management
- Audit Log
- Agent-Kommunikation

Der DevDeck Server speichert nicht zwingend den Sourcecode der Projekte.

---

# 4. DevDeck Agent

Auf jedem Entwicklungsrechner läuft ein kleiner lokaler Agent.

Unterstützt:

```text
Windows
macOS
Linux
```

Aufgaben:

- Maschine beim Server registrieren
- Heartbeat / Online Status
- lokale Workspaces verwalten
- Git Status erfassen
- Workspace Sync
- Workspace Provisioning
- Dependencies installieren
- `.env` erzeugen
- Secret Files bereitstellen
- `.devdeck/` aktualisieren
- Toolchain prüfen
- Terminal öffnen
- Editor öffnen
- Claude Code starten
- Codex starten
- Session Status melden
- Handovers übertragen

Der Agent darf keine unbeschränkte Remote-Shell bereitstellen. Serveraktionen laufen über eine definierte Allowlist.

---

# 5. DevDeck CLI

```text
devdeck status
devdeck sync
devdeck context
devdeck session start
devdeck session finish
devdeck handover import
devdeck changelog add
devdeck decision add
devdeck task add
devdeck secret list
devdeck env run -- <command>
```

Die CLI ist die lokale Schnittstelle für Benutzer, Automatisierung und Coding Agents.

---

# 6. Lokaler Workspace

Beispiel Windows:

```text
D:\Development\WebApp
```

Beispiel macOS:

```text
~/Development/WebApp
```

Beispielstruktur:

```text
WebApp/
|
+-- .git/
+-- src/
+-- package.json
+-- package-lock.json
+-- supabase/
|
+-- .env                    LOCAL / NEVER GIT
+-- credential files        LOCAL / NEVER GIT
+-- node_modules/           LOCAL / REPRODUCIBLE
|
+-- AGENTS.md
+-- CLAUDE.md
|
+-- .devdeck/
    +-- workspace.yaml
    +-- CONTEXT.md
    +-- CURRENT_STATE.md
    +-- CHANGELOG_RECENT.md
    +-- SECRETS.md
    +-- handover/
```

---

# 7. Source of Truth

```text
Sourcecode                    GitHub / GitLab
Code History                  Git
Projects                      DevDeck SQLite
Users                         DevDeck SQLite
Permissions                   DevDeck SQLite
Machines                      DevDeck SQLite
Workspaces                    DevDeck SQLite
Tasks                         DevDeck SQLite
Decisions                     DevDeck SQLite
Full Changelog                DevDeck SQLite
Coding Sessions               DevDeck SQLite
Handovers                     DevDeck SQLite
Secret Metadata               DevDeck SQLite
Secret Values                 DevDeck Vault
Secret Files                  DevDeck Vault
Runtime .env                  Local Workspace, generated
Dependencies                  Local Workspace, reproduced
Coding Context                Local .devdeck/, generated
Production Runtime            Deployment Target
Backups                       Backup Target
```

---

# 8. Git

DevDeck ist kein Git-Ersatz.

```text
GitHub/GitLab
     |
     +--> Alice-PC / WebApp
     +--> Alice-Mac / WebApp
     +--> Bob-Laptop / MobileApp
```

Code-Synchronisierung erfolgt mit Git.

DevDeck kann Git-Aktionen über den lokalen Agent orchestrieren und den Zustand anzeigen.

---

# 9. Workspace Provisioning

Ein neuer Rechner kann ein Projekt reproduzierbar einrichten.

```text
[ PROVISION WORKSPACE ]
          |
          v
Clone Git Repository
          |
          v
Check Toolchain
          |
          v
Install Dependencies
          |
          v
Retrieve authorized Secrets
          |
          v
Generate .env
          |
          v
Retrieve Secret Files
          |
          v
Generate .devdeck Context
          |
          v
Workspace Readiness
          |
          v
READY
```

---

# 10. Workspace Sync

```text
[ SYNC WORKSPACE ]
        |
        v
Check Git Status
        |
        +--> local changes -> warn / safe workflow
        |
        v
Git Update
        |
        v
Dependency Check
        |
        v
Secret Version Check
        |
        v
Secret File Check
        |
        v
Context Refresh
        |
        v
Workspace Readiness
```

Nicht committete Änderungen dürfen nicht ungefragt überschrieben werden.

---

# 11. Workspace Manifest

Versionskontrolliert:

```text
.devdeck/workspace.yaml
```

Beispiel:

```yaml
version: 1

project:
  name: WebApp

runtime:
  node: "24"

package_manager:
  type: npm
  install: npm ci

services:
  supabase: true

mobile:
  android: true
  ios: true

environment:
  source: devdeck
  target: .env

tools:
  - git
  - node
  - npm
  - supabase
```

Keine Secret-Werte im Manifest.

---

# 12. DevDeck Vault

Secret-Werte werden zentral und verschlüsselt gespeichert.

```text
DevDeck SQLite
SUPABASE_SERVICE_ROLE_KEY
       |
       | Vault Reference
       v
DevDeck Vault
       |
       v
Encrypted Value
```

Trennung:

```text
SQLite          = Metadata
Vault           = Secret Values
.env            = lokale Runtime-Projektion
SECRETS.md      = Beschreibung ohne Werte
```

---

# 13. Secret Files

Unterstützt werden zusätzlich verschlüsselte Dateien wie:

```text
google-services.json
GoogleService-Info.plist
service-account.json
*.p8
keystores
certificates
```

DevDeck kennt Projekt, Environment und Zielpfad.

Secret Files werden nur auf autorisierte Workspaces projiziert.

---

# 14. Secret Permissions

Projektzugriff bedeutet nicht automatisch vollständigen Secret-Zugriff.

Mögliche Berechtigungen:

```text
secret.metadata.read
secret.use
secret.reveal
secret.update
secret.file.deploy
```

Development-, Staging- und Production-Secrets können unterschiedlich berechtigt werden.

---

# 15. Machine Registry

Jeder Rechner wird explizit enrolled.

```text
machines

id
owner_user_id
name
platform
agent_version
agent_status
last_seen_at
created_at
```

Beispiele:

```text
Alice-PC       Owner: Alice
Alice-MacBook  Owner: Alice
Bob-Laptop     Owner: Bob
```

---

# 16. Workspace Registry

```text
project_workspaces

id
project_id
machine_id
owner_user_id
local_path
repo_remote
branch
status
last_git_commit
last_sync_at
last_context_sync_at
```

Dadurch kann dasselbe Projekt auf mehreren Rechnern existieren.

---

# 17. Workspace Readiness

Beispiel:

```text
WebApp / Alice MacBook

Git             OK
Repository      OK
Node            OK
npm             OK
Dependencies    OK
Secrets         OK
Credentials     OK
Context         OK
Supabase CLI    OK
Android SDK     WARNING
Xcode           OK

Workspace readiness: WARNING
```

Plattformspezifische Fähigkeiten werden berücksichtigt.

---

# 18. Coding Agents

Claude Code, Codex und zukünftige Coding Agents laufen **direkt im lokalen Projektverzeichnis**.

```text
DevDeck Server
      |
      | authorized start request
      v
DevDeck Agent
      |
      v
Local Project Directory
      |
      v
Claude Code / Codex
```

Der zentrale Server entwickelt nicht auf einer eigenen versteckten Kopie des Projekts.

---

# 19. Coding Context

DevDeck erzeugt aus SQLite kompakte Arbeitsdateien:

```text
.devdeck/
|
+-- CONTEXT.md
+-- CURRENT_STATE.md
+-- CHANGELOG_RECENT.md
+-- SECRETS.md
```

Langfristige History bleibt in SQLite.

Die Coding-KI muss dadurch nicht die vollständige Projekthistorie einlesen.

---

# 20. Coding Session / Handover

```text
DevDeck
   |
   v
Start Coding Session
   |
   v
Local Agent
   |
   +--> refresh context
   +--> record Git state
   +--> register session
   |
   v
Claude / Codex
   |
   v
Structured Handover
   |
   v
Validation
   |
   +--> Changelog
   +--> Decisions
   +--> Tasks
   +--> Session
   +--> Open Items
   |
   v
SQLite
```

Coding Agents schreiben nicht direkt in die Datenbank.

---

# 21. Cross-Machine Workflow

```text
Alice Windows
      |
      v
Claude Coding
      |
      v
Commit + Push + Handover
      |
      +-------------> GitHub
      |
      +-------------> DevDeck

Next day

Alice Mac
      |
      v
SYNC WORKSPACE
      |
      +--> Git update
      +--> dependencies
      +--> secrets
      +--> context
      |
      v
Start Claude
```

Damit kennt die neue Coding Session den vorherigen Arbeitsstand.

---

# 22. WebApp

```text
WebApp
|
+-- Owner: Alice
+-- Git repository
+-- Alice Windows Workspace
+-- Alice macOS Workspace
+-- optional Linux Workspace
+-- Services
|   +-- Supabase
|   +-- Vercel / Hosting
|   +-- Brevo
|   +-- IONOS
|   +-- Apple
|   +-- Google Play
+-- Secrets
+-- Secret Files
+-- Tasks
+-- Decisions
+-- Changelog
+-- Handovers
+-- Backups
```

---

# 23. MobileApp

```text
MobileApp
|
+-- Owner: Bob
+-- Git repository
+-- Bob Laptop Workspace
+-- project-specific Services
+-- Secrets
+-- Secret Files
+-- Tasks
+-- Decisions
+-- Changelog
+-- Handovers
+-- Backups
```

MobileApp wird über dieselben Mechanismen wie WebApp verwaltet.

---

# 24. Multi-User

DevDeck wird nicht für genau zwei Benutzer gebaut.

```text
Users
|
+-- Alice
+-- Bob
+-- future developers...

Projects
|
+-- WebApp
+-- MobileApp
+-- future projects...
```

Berechtigungen werden über Project Memberships verwaltet.

---

# 25. Audit Log

Kritische Aktionen werden protokolliert:

```text
Login
Machine Enrollment
Project Membership Change
Secret Change
Secret Projection
Workspace Provisioning
Workspace Sync
Coding Session
Backup
Restore
```

Secret-Werte selbst dürfen nicht im Audit Log stehen.

---

# 26. Deployment

Development und Production bleiben getrennt.

```text
Local Workspace
      |
      v
Git Commit / Push
      |
      v
GitHub / GitLab
      |
      v
Deployment
      |
      +--> Vercel
      +--> Linux
      +--> IONOS
      +--> Mobile Stores
      |
      v
Backend Services
Supabase / Brevo / etc.
```

---

# 27. Backups

DevDeck verwaltet zwei Backup-Klassen.

## System Backup

```text
DevDeck Server
|
+-- SQLite
+-- Vault
+-- Secret Files
+-- Configuration
+-- Users
+-- Permissions
+-- History
+-- Audit Log
```

## Projekt-Backups

Beispielsweise:

```text
Supabase
|
+-- Database
+-- Storage Files
```

Backups sollen auf einem vom Primärsystem unabhängigen Ziel gespeichert werden.

---

# 28. Security

Grundregeln:

1. DevDeck Server nicht ungeschützt öffentlich exponieren.
2. Browser- und Agent-Kommunikation authentifizieren und verschlüsseln.
3. Passwörter nur gehasht speichern.
4. Vault-Inhalte verschlüsseln.
5. Keine Secret-Werte in Context, Logs oder Changelogs.
6. Machines explizit enrollen.
7. Agent Credentials widerrufbar machen.
8. Agent nur definierte lokale Aktionen erlauben.
9. Keine generische Remote-Shell als Standardfunktion.
10. Destruktive Aktionen gesondert bestätigen.
11. Berechtigungen serverseitig prüfen.
12. Backups unabhängig absichern.

---

# 29. Roadmap

## Phase 1 - DevDeck Server

- Linux VM
- Web UI/API
- SQLite
- Login
- `admin@example.com` als Admin
- `bob@example.com` als zusätzlicher Benutzer
- Projects
- WebApp
- MobileApp
- Project Memberships

## Phase 2 - DevDeck Agent

- Windows
- macOS
- Linux
- Machine Enrollment
- Heartbeat
- Machine Registry
- Workspace Registry

## Phase 3 - Workspace Management

- Workspace Manifest
- Provision Workspace
- Sync Workspace
- Toolchain Check
- Dependency Setup
- Workspace Readiness

## Phase 4 - Knowledge

- Tasks
- Decisions
- Changelog
- Full History
- Sessions
- Handovers
- Search
- Cross-Machine Handover

## Phase 5 - DevDeck Vault

- encrypted Vault
- `.env` Projection
- Secret Files
- Project/Environment Permissions
- Secret Audit

## Phase 6 - CLI & Coding Agents

- DevDeck CLI
- Claude Code Launcher
- Codex Launcher
- Session Tracking
- structured Handover

## Phase 7 - Backups

- DevDeck System Backup
- Vault Backup
- Supabase DB Backup
- Supabase Storage Backup
- Scheduling
- Retention
- Restore

## Phase 8 - Service Integrations

- GitHub
- GitLab
- Supabase
- Vercel
- Brevo
- Apple
- Google Play
- IONOS

## Phase 9 - Optional DevDeck AI

Erst später:

- AI Provider Interface
- Ask DevDeck
- Smart Project Preparation
- Smart Summaries
- Semantic Search
- Decision Suggestions
- Next-Step Suggestions

**DevDeck muss jederzeit vollständig mit AI = disabled funktionieren.**

---

# 30. Zielbild

> **DevDeck ist das zentrale selbst gehostete Control Plane und Projektgedächtnis für Entwicklung. Git verwaltet den Code, DevDeck Wissen und Secrets, lokale DevDeck Agents reproduzieren und steuern Workspaces, und Coding Agents arbeiten direkt im jeweiligen lokalen Projektverzeichnis.**
