# DevDeck v5 - Systemstruktur

## 1. Zweck

Dieses Dokument beschreibt die technische Gesamtstruktur von **DevDeck v5**: Komponenten, Speicherorte, Benutzerzugriffe, Datenflüsse und die Trennung zwischen zentralem Control Plane, lokalen Entwicklungsumgebungen, Git, Deployment und Backups.

## 2. Gesamtübersicht

```text
                          EXTERNE DIENSTE

       +----------------+ +----------------+ +----------------+
       | GitHub/GitLab  | | Vercel/IONOS  | | Supabase/Brevo |
       | Source Code    | | Deployment     | | App Services   |
       +-------+--------+ +-------+--------+ +-------+--------+
               |                  |                  |
               +------------------+------------------+
                                  |
                         Trusted Network / VPN
                                  |
                         +--------v---------+
                         | DevDeck Server   |
                         | Linux VM         |
                         |                  |
                         | Web UI / API     |
                         | SQLite           |
                         | DevDeck Vault    |
                         | Secret Files     |
                         | Users/Roles      |
                         | Tasks/Decisions  |
                         | History          |
                         | Handovers        |
                         | Machine Registry |
                         | Backups/Audit    |
                         +--------+---------+
                                  |
                     authenticated Agent links
                     +------------+------------+
                     |                         |
                     v                         v
           +--------------------+    +--------------------+
           | Alice            |    | Bob              |
           | PC / Mac / Linux   |    | Laptop             |
           | DevDeck Agent      |    | DevDeck Agent      |
           | DevDeck CLI        |    | DevDeck CLI        |
           | WebApp          |    | MobileApp         |
           | .env / deps        |    | .env / deps        |
           | .devdeck/          |    | .devdeck/          |
           | Claude / Codex     |    | Coding Agent       |
           +--------------------+    +--------------------+
```

## 3. Verantwortlichkeiten

```text
GitHub/GitLab      = Source of Truth für Sourcecode und Code-History
DevDeck SQLite     = Source of Truth für Projektwissen und Verwaltung
DevDeck Vault      = Source of Truth für Secret-Werte und Secret Files
Local Workspace    = aktive, reproduzierbare Arbeitskopie
Deployment Target  = laufende Anwendung
Backup Target      = unabhängige Sicherung
```

## 4. DevDeck Server

Der **DevDeck Server** läuft zentral auf einer Linux-VM und unabhängig von den Entwicklungsrechnern.

```text
DevDeck Server
|
+-- Web UI
+-- API
+-- Authentication
+-- Authorization
+-- Agent Communication
+-- SQLite
+-- DevDeck Vault
+-- Encrypted Secret Files
+-- Project Knowledge
+-- Backup Management
+-- Audit Log
+-- optional später: DevDeck AI
```

Benutzer greifen über den Browser auf den Server zu. Der Server soll nicht ungeschützt öffentlich exponiert werden.

## 5. Benutzer und Projekte

Initial:

```text
admin@example.com
System Role: admin
WebApp: owner


bob@example.com
System Role: developer
MobileApp: owner
```

Projektrollen:

```text
owner
maintainer
developer
viewer
```

Systemrolle und Projektrolle bleiben getrennt. Weitere Benutzer und Projekte können später ergänzt werden.

## 6. Entwicklungsrechner

### Alice

```text
Alice-PC
+-- Windows
+-- DevDeck Agent
+-- DevDeck CLI
+-- Git
+-- Toolchains
+-- Claude Code / Codex
+-- WebApp Workspace

Alice-MacBook
+-- macOS
+-- DevDeck Agent
+-- DevDeck CLI
+-- Git
+-- Toolchains
+-- Claude Code / Codex
+-- WebApp Workspace
```

### Bob

```text
Bob-Laptop
+-- OS wird beim Enrollment erkannt/registriert
+-- DevDeck Agent
+-- DevDeck CLI
+-- Git
+-- benötigte Toolchains
+-- Coding Agent
+-- MobileApp Workspace
```

## 7. Machine Enrollment

```text
User Login
    |
    v
DevDeck > Machines > Add Machine
    |
    v
Temporary Enrollment / Pairing
    |
    v
Install DevDeck Agent
    |
    v
Agent Authentication
    |
    v
Machine registered
```

Die Machine Registry hält unter anderem Besitzer, Namen, Plattform, Agent-Version, Online-Status, Last Seen und Credential-Status.

## 8. DevDeck Agent

Der lokale **DevDeck Agent** verbindet Server und Entwicklungsrechner.

Er übernimmt definierte Aktionen wie:

- Workspace-Status erfassen
- Git-Status erfassen
- Workspace Sync
- Workspace Provisioning
- Dependencies installieren
- `.env` generieren
- Secret Files bereitstellen
- `.devdeck/` aktualisieren
- Toolchains prüfen
- Terminal oder Editor öffnen
- Claude Code / Codex starten
- Session-Status melden
- Handovers übertragen

Der Agent bietet standardmäßig keine generische unbegrenzte Remote-Shell. Er arbeitet mit einer serverseitig autorisierten Action-Allowlist.

## 9. DevDeck CLI

```bash
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

Die CLI ist die lokale Schnittstelle für Benutzer, Scripts und Coding Agents.

## 10. Workspace Registry

Ein Projekt kann auf mehreren registrierten Maschinen existieren.

```text
WebApp
+-- Alice-PC       D:\Development\WebApp
+-- Alice-MacBook  ~/Development/WebApp

MobileApp
+-- Bob-Laptop     <configured local workspace>
```

Konzeptionelles Datenmodell:

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
created_at
updated_at
```

## 11. Inhalt eines lokalen Workspaces

```text
WebApp/
|
+-- .git/
+-- src/
+-- package.json
+-- package-lock.json
+-- supabase/
|
+-- .env                     LOCAL / NEVER GIT
+-- credential files         LOCAL / NEVER GIT
+-- node_modules/            LOCAL / REPRODUCIBLE
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

## 12. Herkunft der Workspace-Bestandteile

```text
                       LOCAL WORKSPACE
                             |
          +------------------+------------------+
          |                  |                  |
          v                  v                  v
         Git            DevDeck Vault      DevDeck SQLite
          |                  |                  |
          v                  v                  v
      Sourcecode            .env             Context
      Config Files       Secret Files       Current State
      Lockfiles                             Changelog
      Migrations                            Decisions
                                            Tasks
          |
          v
   Dependency Manager
          |
          v
   Local Dependencies
```

## 13. Git

GitHub beziehungsweise GitLab bleibt die Source of Truth für Sourcecode.

```text
GitHub/GitLab
     |
     +--> Alice-PC / WebApp
     +--> Alice-MacBook / WebApp
     +--> Bob-Laptop / MobileApp
```

DevDeck ersetzt Git nicht. DevDeck kann lokale Git-Aktionen über den Agent orchestrieren und den Zustand erfassen.

### In Git

- Sourcecode
- Dependency-Manifeste und Lockfiles
- DB-Migrationen
- Tests
- Dokumentation
- nicht geheime Projektkonfiguration
- `AGENTS.md`
- `CLAUDE.md`
- `.devdeck/workspace.yaml`

### Nicht in Git

- `.env`
- API Keys
- Passwörter
- Signing Keys
- private Zertifikate
- private Credential Files
- `node_modules`
- Build Output

## 14. Workspace Manifest

Das versionskontrollierte Manifest liegt unter:

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

Das Manifest enthält keine Secret-Werte.

## 15. Dependencies

Dependencies werden auf jedem Entwicklungsrechner lokal reproduziert und nicht zwischen Maschinen kopiert.

```text
package.json + package-lock.json
               |
               v
            npm ci
               |
               v
         node_modules/
```

Der DevDeck Agent kann anhand des Workspace-Manifests erkennen, welche Installationsstrategie vorgesehen ist.

## 16. DevDeck Vault

Secret-Werte liegen zentral und verschlüsselt im **DevDeck Vault**.

```text
DevDeck SQLite
Secret Metadata
      |
      | Vault Reference
      v
DevDeck Vault
Encrypted Value
```

Trennung:

```text
DevDeck SQLite = Metadata
DevDeck Vault  = Secret Values / Secret Files
.env           = lokale Runtime-Projektion
SECRETS.md     = Namen und Beschreibungen ohne Werte
```

## 17. `.env` Workflow

`.env` ist nicht die Source of Truth.

```text
DevDeck Vault
     |
     v
DevDeck Server
     |
     v
Authorized DevDeck Agent
     |
     v
Generate / Update .env
     |
     v
Local Workspace
```

## 18. Secret Files

Beispiele:

```text
google-services.json
GoogleService-Info.plist
service-account.json
*.p8
keystores
certificates
```

Workflow:

```text
DevDeck Vault
Encrypted Secret File
       |
       v
DevDeck Server
       |
       v
Authorized DevDeck Agent
       |
       v
Configured local destination
```

Secret Files werden nur in autorisierte Workspaces projiziert und gehören nicht in Coding Context, Changelog oder Audit Log.

## 19. Environments und Secret Permissions

```text
Project
+-- Development
+-- Staging
+-- Production
```

Mögliche Secret Capabilities:

```text
secret.metadata.read
secret.use
secret.reveal
secret.update
secret.file.deploy
```

Projektzugriff bedeutet nicht automatisch uneingeschränkten Zugriff auf Production Secrets.

## 20. DevDeck SQLite

Die zentrale SQLite-Datenbank liegt auf dem DevDeck Server.

Sie enthält unter anderem:

```text
Users
Projects
Project Memberships
Machines
Workspaces
Services
Environments
Tasks
Decisions
Changelog
Coding Sessions
Handovers
Secret Metadata
Backup Configuration
Backup History
Audit Log
```

Unverschlüsselte Secret-Werte gehören nicht in die normale SQLite-Datenbank.

## 21. Projektwissen und History

Langfristiges Wissen bleibt zentral in SQLite:

```text
Complete Changelog History
Coding Sessions
Handovers
Decisions
Tasks
Known Issues
Git Metadata
```

Lokale Markdown-Dateien sind nur kompakte Arbeitsansichten und nicht die langfristige Source of Truth.

## 22. `.devdeck/` als Coding-Agent-Bridge

```text
DevDeck SQLite
      |
      v
Context Builder
      |
      v
DevDeck Agent
      |
      v
.devdeck/
      +-- CONTEXT.md
      +-- CURRENT_STATE.md
      +-- CHANGELOG_RECENT.md
      +-- SECRETS.md
```

`SECRETS.md` enthält keine Secret-Werte.

## 23. Coding Agents

Claude Code, Codex und zukünftige Coding Agents arbeiten im tatsächlichen lokalen Workspace.

```text
DevDeck Web UI
      |
      v
DevDeck Server
      |
      v
DevDeck Agent
      |
      v
cd <local project workspace>
      |
      v
Claude Code / Codex
```

Der DevDeck Server führt den Coding Agent nicht auf einer eigenen versteckten Projektkopie aus.

## 24. Coding Session und Handover

```text
User
 |
 v
DevDeck Web UI / CLI
 |
 v
DevDeck Server
 |
 v
DevDeck Agent
 |
 +--> Check Workspace
 +--> Refresh Context
 +--> Record Git State
 +--> Register Session
 |
 v
Claude Code / Codex
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
DevDeck SQLite
```

Coding Agents schreiben nicht direkt in SQLite.

## 25. Cross-Machine Handover

```text
Alice Windows
      |
      v
Coding Session
      |
      +--> Commit / Push --------> GitHub/GitLab
      |
      +--> Handover -------------> DevDeck

Alice Mac
      |
      v
Sync Workspace
      |
      +--> Git Update
      +--> Dependency Check
      +--> Secret Update
      +--> Secret File Check
      +--> Context Refresh
      |
      v
Start next Coding Session
```

## 26. Provision Workspace

```text
New Machine
   |
   v
Enroll DevDeck Agent
   |
   v
Choose Project
   |
   v
PROVISION WORKSPACE
   |
   +--> Clone Git Repository
   +--> Check Toolchain
   +--> Install Dependencies
   +--> Retrieve authorized Secrets
   +--> Generate .env
   +--> Retrieve Secret Files
   +--> Generate .devdeck Context
   +--> Workspace Readiness
   |
   v
READY
```

## 27. Sync Workspace

```text
Local Workspace
      |
      v
Check Git Status
      |
      +--> local changes? -> safe workflow / warning
      |
      v
Git Sync
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

Nicht committete Änderungen dürfen nicht stillschweigend überschrieben werden.

## 28. Workspace Readiness

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

Anforderungen können plattformspezifisch definiert werden.

## 29. WebApp

```text
WebApp
+-- Owner: Alice
+-- Git Repository
+-- Workspaces
|   +-- Alice Windows
|   +-- Alice macOS
|   +-- optional Linux
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
+-- Changelog / History
+-- Handovers
+-- Backups
```

## 30. MobileApp

```text
MobileApp
+-- Owner: Bob
+-- Git Repository
+-- Workspace
|   +-- Bob Laptop
+-- Project-specific Services
+-- Secrets
+-- Secret Files
+-- Tasks
+-- Decisions
+-- Changelog / History
+-- Handovers
+-- Backups
```

MobileApp wird über dieselbe DevDeck-Infrastruktur wie WebApp verwaltet.

## 31. Deployment

Development, Sourcecode und Production bleiben getrennt.

```text
Local Development
       |
       v
Git Commit / Push
       |
       v
GitHub / GitLab
       |
       v
Deployment Process
       |
       +--> Vercel
       +--> Linux Server
       +--> IONOS
       +--> Mobile Build / Stores
       |
       v
Backend / External Services
```

DevDeck kann Integrationen orchestrieren und dokumentieren, ersetzt Git aber nicht als Sourcecode-Transport.

## 32. Backups

DevDeck unterscheidet System- und Projektbackups.

```text
DevDeck Backup Management
          |
          +---------------------+
          |                     |
          v                     v
DevDeck System Backup       Project Backup
          |                     |
          +-- SQLite            +-- Supabase DB
          +-- Vault             +-- Supabase Storage
          +-- Secret Files      +-- weitere Connectoren
          +-- Configuration
          +-- History
          +-- Users/Roles
          +-- Audit Log
```

Backups sollen auf ein vom Primärsystem unabhängiges Ziel geschrieben werden.

## 33. Audit Log

Auditierbare Aktionen umfassen beispielsweise:

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

Secret-Werte selbst gehören niemals in das Audit Log.

## 34. Kommunikationswege

### Browser -> DevDeck Server

```text
HTTPS / trusted network
Authenticated user session
```

Für Web UI, Projekte, Tasks, History, Backups und Administration.

### DevDeck Agent -> DevDeck Server

```text
Authenticated encrypted connection
Machine Identity
```

Für Heartbeat, Workspace Status, autorisierte Actions, Context Sync, Session Status und Handover Upload.

### DevDeck CLI -> Agent / Server

Für Status, Sync, Context, Sessions, Handovers, Tasks und Decisions.

### Workspace -> Git

Für Clone, Fetch, Pull und Push.

## 35. Security Boundaries

```text
+-------------------------+
| DevDeck Server          |
| trusted control plane   |
+------------+------------+
             |
     authenticated boundary
             |
+------------v------------+
| DevDeck Agent           |
| controlled actions      |
+------------+------------+
             |
       local OS boundary
             |
+------------v------------+
| Local Workspace         |
| code / runtime          |
+-------------------------+
```

Beispiele erlaubter Agent-Aktionen:

```text
workspace.status
workspace.sync
workspace.provision
context.refresh
env.refresh
dependencies.install
editor.open
terminal.open
coding_agent.start
```

## 36. Source-of-Truth Matrix

| Daten/Funktion | Source of Truth |
|---|---|
| Sourcecode | GitHub / GitLab |
| Code History | Git |
| Project Metadata | DevDeck SQLite |
| Users | DevDeck SQLite |
| Permissions | DevDeck SQLite |
| Machines | DevDeck SQLite |
| Workspace Registry | DevDeck SQLite |
| Tasks | DevDeck SQLite |
| Decisions | DevDeck SQLite |
| Full Changelog | DevDeck SQLite |
| Coding Sessions | DevDeck SQLite |
| Handovers | DevDeck SQLite |
| Secret Metadata | DevDeck SQLite |
| Secret Values | DevDeck Vault |
| Secret Files | DevDeck Vault |
| Runtime `.env` | Local Workspace, generated |
| Dependencies | Local Workspace, reproduced |
| Coding Context | Local `.devdeck/`, generated |
| Production Runtime | Deployment Target |
| DevDeck System Backup | Backup Target |
| Project Data Backup | Backup Target |

## 37. Ausfall eines Entwicklungsrechners

Wiederherstellbare Bestandteile:

```text
Code             <- Git
Secrets          <- DevDeck Vault
Secret Files     <- DevDeck Vault
Dependencies     <- manifests + lockfiles
Project Context  <- DevDeck SQLite
History          <- DevDeck SQLite
Tasks            <- DevDeck SQLite
Decisions        <- DevDeck SQLite
Workspace Config <- workspace manifest + DevDeck SQLite
```

Danach kann der Workspace über Enrollment und Provisioning auf einem neuen Rechner wiederhergestellt werden. Nicht commitete und nicht anderweitig gesicherte lokale Arbeit bleibt grundsätzlich ein lokales Risiko.

## 38. Ausfall der DevDeck VM

Der DevDeck Server benötigt regelmäßige unabhängige Systembackups von:

```text
SQLite
DevDeck Vault
Secret Files
Server Configuration
Users / Permissions
History / Handovers
Audit Log
Backup Metadata
```

Der Sourcecode bleibt unabhängig davon in Git verfügbar.

## 39. Optionale DevDeck AI

Eine spätere DevDeck AI ist eine optionale Serverfunktion.

```text
Selected DevDeck Data
       |
       v
Context / Security Filter
       |
       | remove secrets
       v
Optional AI Provider
       |
       +--> Ask DevDeck
       +--> Smart Summary
       +--> Semantic Search
       +--> Decision Suggestions
       +--> Next Steps
```

DevDeck muss vollständig funktionsfähig bleiben, wenn diese AI deaktiviert ist.

## 40. Endgültiges Gesamtbild

```text
                            +-------------------+
                            | GitHub / GitLab   |
                            | SOURCE CODE       |
                            +---------+---------+
                                      |
                  +-------------------+-------------------+
                  |                                       |
                  v                                       v
       +----------------------+                 +----------------------+
       | Alice              |                 | Bob                |
       | Windows/Mac/Linux    |                 | Laptop               |
       |                      |                 |                      |
       | DevDeck Agent        |                 | DevDeck Agent        |
       | DevDeck CLI          |                 | DevDeck CLI          |
       | WebApp Workspace  |                 | MobileApp Workspace |
       | + .env               |                 | + .env               |
       | + Dependencies       |                 | + Dependencies       |
       | + Secret Files       |                 | + Secret Files       |
       | + .devdeck/          |                 | + .devdeck/          |
       | + Claude/Codex       |                 | + Coding Agent       |
       +----------+-----------+                 +-----------+----------+
                  |                                         |
                  +--------------------+--------------------+
                                       |
                                       v
                           +-------------------------+
                           | DevDeck Server          |
                           | Linux VM                |
                           |                         |
                           | Web UI / API            |
                           | Auth / Permissions      |
                           | SQLite                  |
                           | DevDeck Vault           |
                           | Secret Files            |
                           | Project Knowledge       |
                           | Machines / Workspaces   |
                           | Backup Management       |
                           | Audit Log               |
                           +------------+------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
                  +-------------+               +-------------+
                  | Production  |               | Backups     |
                  | Vercel      |               | NAS/other   |
                  | Linux/IONOS |               | target      |
                  | Supabase    |               +-------------+
                  | Brevo       |
                  | App Stores  |
                  +-------------+
```

## 41. Zusammenfassung

> **Git verwaltet den Code. DevDeck verwaltet Projekte, Wissen, Benutzer, Maschinen, Workspaces und Secrets. DevDeck Agents reproduzieren und steuern lokale Entwicklungsumgebungen. Coding Agents arbeiten direkt im jeweiligen lokalen Workspace. Deployment und Backups bleiben getrennte Zielsysteme.**
