# DevDeck

DevDeck ist ein zentral selbst gehostetes Developer Control Plane für mehrere Entwickler, Projekte und Entwicklungsrechner. Es verbindet zentrale Projektverwaltung mit lokalen Git-Workspaces, reproduzierbaren Entwicklungsumgebungen, Secret-Management, Coding-Agent-Workflows und Backups.

> Git verwaltet den Code. DevDeck verwaltet Projekte, Wissen, Workspaces, Secrets und Entwicklungsabläufe. Die eigentliche Entwicklung findet auf dem jeweiligen Entwicklerrechner statt.

## Warum DevDeck?

Bei Entwicklung auf mehreren PCs, Macs oder Linux-Systemen besteht ein Projekt nicht nur aus dem Inhalt eines Git-Repositories. Zusätzlich werden lokale Dependencies, `.env`-Dateien, Credentials, Toolchains, Projektkontext und Informationen aus vorherigen Coding-Sessions benötigt.

DevDeck soll einen Workspace auf einem anderen oder neuen Rechner reproduzierbar arbeitsfähig machen, ohne Sourcecode über OneDrive oder einen eigenen proprietären Datei-Sync verteilen zu müssen.

## Architektur

DevDeck besteht aus drei Hauptkomponenten:

```text
                         GitHub / GitLab
                         Source Code
                              |
             +----------------+----------------+
             |                                 |
             v                                 v
      Alice Rechner                     Bob Laptop
      Windows/macOS/Linux                       |
             |                                 |
       DevDeck Agent                     DevDeck Agent
       DevDeck CLI                       DevDeck CLI
             |                                 |
             v                                 v
      WebApp Workspace               MobileApp Workspace
             |                                 |
       Claude / Codex                     Coding Agent
             |                                 |
             +----------------+----------------+
                              |
                              v
                       DevDeck Server
                         Linux VM
                 +-----------------------+
                 | Web UI / API          |
                 | SQLite                |
                 | DevDeck Vault         |
                 | Users / Permissions   |
                 | Tasks / Decisions     |
                 | History / Handovers   |
                 | Machine Registry      |
                 | Backup Management     |
                 | Audit Log             |
                 +-----------------------+
```

## 1. DevDeck Server

Der DevDeck Server läuft zentral auf einer Linux-VM. Benutzer greifen über die Weboberfläche darauf zu.

Er verwaltet:

- Benutzer und Login
- Projekte und Projektmitgliedschaften
- Maschinen und lokale Workspaces
- Tasks und Decisions
- Changelog und vollständige Projekthistorie
- Coding Sessions und Handovers
- Secret-Metadaten
- verschlüsselten DevDeck Vault
- Secret Files
- Backup-Konfiguration und Backup-Historie
- Audit Log

Der DevDeck Server ist **nicht** der zentrale Speicherort des Sourcecodes. Dafür bleibt GitHub oder GitLab zuständig.

## 2. DevDeck Agent

Auf jedem Entwicklungsrechner läuft ein lokaler DevDeck Agent.

Der Agent bildet die sichere Brücke zwischen dem zentralen Server und dem lokalen Rechner. Er kann definierte lokale Aktionen ausführen, zum Beispiel:

- Workspace-Status prüfen
- Git-Status erfassen
- Workspace synchronisieren
- neuen Workspace provisionieren
- Dependencies installieren
- `.env` erzeugen oder aktualisieren
- benötigte Secret Files bereitstellen
- `.devdeck/` aktualisieren
- Toolchain prüfen
- Terminal oder Editor öffnen
- Claude Code oder Codex im Projektverzeichnis starten
- Coding Sessions und Handovers an DevDeck melden

Der Agent soll keine generische unbegrenzte Remote-Shell bereitstellen. Er arbeitet mit einer festgelegten Allowlist unterstützter Aktionen.

## 3. DevDeck CLI

Die CLI dient Entwicklern, Scripts und Coding Agents als lokale Schnittstelle.

Geplante Befehle:

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

## 4. Sourcecode und Git

GitHub oder GitLab bleibt die Source of Truth für den Sourcecode.

```text
Git Repository
   |
   +--> Alice Windows Workspace
   +--> Alice Mac Workspace
   +--> Bob MobileApp Workspace
```

DevDeck ersetzt Git nicht. Es kann Git-Zustände anzeigen und Git-Aktionen über den jeweiligen lokalen Agent orchestrieren.

In Git gehören beispielsweise:

- Sourcecode
- `package.json`
- Lockfiles
- Datenbank-Migrationen
- Tests
- nicht geheime Konfiguration
- `AGENTS.md`
- `CLAUDE.md`
- `.devdeck/workspace.yaml`

Nicht in Git gehören beispielsweise:

- `.env`
- API Keys
- Passwörter
- private Zertifikate
- Signing Keys
- private Credential Files
- `node_modules`
- Build-Artefakte

## 5. Lokaler Workspace

Die eigentliche Entwicklung findet lokal statt.

Beispiele:

```text
Windows
D:\Development\WebApp

macOS
~/Development/WebApp
```

Ein typischer Workspace sieht so aus:

```text
WebApp/
|
+-- .git/
+-- src/
+-- package.json
+-- package-lock.json
+-- supabase/
|
+-- .env
+-- node_modules/
+-- lokale Credential Files
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

## 6. Workspace Manifest

`.devdeck/workspace.yaml` beschreibt, was ein Projekt für einen arbeitsfähigen Workspace benötigt.

Konzeptionelles Beispiel:

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

## 7. Workspace Provisioning

Auf einem neuen Entwicklungsrechner soll ein Projekt über **Provision Workspace** eingerichtet werden können.

```text
Clone Git Repository
        |
        v
Toolchain prüfen
        |
        v
Dependencies installieren
        |
        v
Autorisierte Secrets beziehen
        |
        v
.env generieren
        |
        v
Secret Files bereitstellen
        |
        v
.devdeck Kontext erzeugen
        |
        v
Workspace Readiness prüfen
        |
        v
READY
```

Dadurch wird der Entwicklungsrechner weitgehend ersetzbar.

## 8. Workspace Sync

**Sync Workspace** bringt einen vorhandenen Workspace auf den aktuellen Zustand.

Der vorgesehene Ablauf umfasst:

1. Git-Status prüfen.
2. Lokale Änderungen erkennen und vor konfliktträchtigen Aktionen warnen.
3. Git aktualisieren.
4. Dependency-Status prüfen.
5. Secret-Versionen prüfen.
6. Secret Files prüfen.
7. DevDeck Context aktualisieren.
8. Workspace Readiness neu bewerten.

Lokale, nicht committete Änderungen dürfen nicht stillschweigend überschrieben werden.

## 9. Dependencies

Installierte Libraries werden nicht zwischen Rechnern synchronisiert.

Stattdessen enthält Git die Dependency-Manifeste und Lockfiles. Der lokale Rechner reproduziert daraus seine Dependencies.

Beispiel:

```text
package.json + package-lock.json
                |
                v
             npm ci
                |
                v
          node_modules/
```

## 10. DevDeck Vault

Secret-Werte werden zentral und verschlüsselt im DevDeck Vault gespeichert.

Die Verantwortlichkeiten sind getrennt:

```text
DevDeck SQLite   -> Secret-Metadaten
DevDeck Vault    -> tatsächliche Secret-Werte
Local .env       -> generierte Runtime-Projektion
SECRETS.md       -> Namen/Beschreibungen ohne Secret-Werte
```

`.env` ist damit nicht die zentrale Source of Truth.

## 11. Secret Files

DevDeck berücksichtigt auch Credentials, die als Datei benötigt werden, zum Beispiel:

```text
google-services.json
GoogleService-Info.plist
service-account.json
*.p8
keystores
certificates
```

Zu jeder Secret File können Projekt, Environment und lokaler Zielpfad hinterlegt werden.

Secret Files werden nur in autorisierte Workspaces projiziert und nicht in den Coding Context geschrieben.

## 12. Environments und Berechtigungen

DevDeck unterscheidet mindestens:

```text
Development
Staging
Production
```

Projektzugang bedeutet nicht automatisch Zugriff auf alle Secrets.

Geplante Secret-Fähigkeiten:

```text
secret.metadata.read
secret.use
secret.reveal
secret.update
secret.file.deploy
```

Damit kann der Zugriff auf Development- und Production-Secrets unterschiedlich geregelt werden.

## 13. Machine Registry

Jeder Entwicklungsrechner wird explizit mit DevDeck verbunden.

Der Server kennt beispielsweise:

- Besitzer
- Rechnername
- Plattform
- Agent-Version
- Online-Status
- Last Seen
- registrierte Workspaces

Initiale Beispiele:

```text
Alice-PC
Alice-MacBook
Bob-Laptop
```

## 14. Multi-User und Multi-Project

DevDeck wird von Beginn an für mehrere Entwickler und Projekte ausgelegt.

Initial:

```text
admin@example.com
System Role: admin
WebApp: owner


bob@example.com
System Role: developer
MobileApp: owner
```

**Login-Credentials:**
- **Admin:** `admin@example.com` (Passwort über `DEVDECK_ADMIN_PASSWORD` konfigurierbar)
- **Developer:** `bob@example.com` (Passwort über `DEVDECK_ADMIN_PASSWORD` konfigurierbar)

Weitere Benutzer und Projekte können später hinzugefügt werden.

Projektrollen:

```text
owner
maintainer
developer
viewer
```

Systemrolle und Projektrolle sind voneinander getrennt.

## 15. Coding Agents

Claude Code, Codex und zukünftige Coding Agents laufen direkt im jeweiligen lokalen Projektverzeichnis.

```text
DevDeck Web UI
      |
      v
DevDeck Server
      |
      v
DevDeck Agent auf ausgewähltem Rechner
      |
      v
lokales Projektverzeichnis
      |
      v
Claude Code / Codex
```

Dadurch arbeitet die Coding-KI mit der echten lokalen Working Copy inklusive installierter Dependencies und des für diesen Workspace vorbereiteten Contexts.

## 16. Coding Context

DevDeck erzeugt kompakte Arbeitsinformationen unter `.devdeck/`.

```text
CONTEXT.md
CURRENT_STATE.md
CHANGELOG_RECENT.md
SECRETS.md
```

Die vollständige Projekthistorie bleibt in SQLite. Die lokalen Markdown-Dateien sind eine kompakte Bridge für Coding Agents.

`SECRETS.md` enthält keine Secret-Werte.

## 17. Coding Sessions und Handovers

Eine Coding Session wird in DevDeck erfasst.

Nach einer Session kann ein Coding Agent einen strukturierten Handover liefern, beispielsweise mit:

- Ziel der Session
- erledigten Punkten
- offenen Punkten
- expliziten Entscheidungen
- geänderten Dateien
- Commit-Referenz
- Changelog-Zusammenfassung

Der Coding Agent schreibt nicht direkt in SQLite. DevDeck validiert die strukturierte Übergabe und übernimmt zulässige Daten.

## 18. Rechnerwechsel

Beispiel: Alice arbeitet zunächst auf Windows und später auf dem Mac.

```text
Windows
  |
  +--> Entwicklung
  +--> Commit + Push
  +--> Handover an DevDeck

Mac
  |
  +--> Sync Workspace
       +--> Git aktualisieren
       +--> Dependencies prüfen
       +--> Secrets aktualisieren
       +--> Context aktualisieren
  |
  +--> Coding Session fortsetzen
```

Der Sourcecode kommt aus Git. Projektwissen und Handover kommen aus DevDeck. Secrets kommen aus dem Vault. Dependencies werden lokal reproduziert.

## 19. WebApp

WebApp ist zunächst Alices Projekt.

Vorgesehene Bestandteile:

- Git Repository
- Windows/macOS und optional Linux Workspaces
- Supabase
- Hosting/Deployment, z. B. Vercel, Linux oder IONOS
- Brevo
- Apple/Google-relevante Projektkonfiguration
- Secrets und Secret Files
- Tasks
- Decisions
- Changelog
- Handovers
- Backups

## 20. MobileApp

MobileApp ist zunächst Bobs Projekt.

Es verwendet dieselbe DevDeck-Infrastruktur:

- eigenes Git Repository
- eigener Workspace auf Bobs Laptop
- eigene Services
- eigene Secrets und Secret Files
- eigene Tasks und Decisions
- eigene History
- eigene Coding Sessions und Handovers
- eigene Backup-Konfiguration

## 21. Deployment

Development, Sourcecode und Production bleiben getrennte Ebenen.

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
Deployment
       |
       +--> Vercel
       +--> Linux
       +--> IONOS
       +--> Mobile Build / Stores
       |
       v
Backend Services
z. B. Supabase
```

DevDeck kann Deployment-Integrationen später ergänzen. Git bleibt der Sourcecode-Transport.

## 22. Backups

DevDeck unterscheidet System- und Projektbackups.

### DevDeck System Backup

Zu sichern sind insbesondere:

- SQLite
- verschlüsselter Vault
- Secret Files
- Serverkonfiguration
- Benutzer und Berechtigungen
- History und Handovers
- Audit-Daten

### Projektbackups

Projektbezogene Backup-Integrationen können beispielsweise Datenbanken oder Storage umfassen.

Backups sollen auf einem vom Primärsystem unabhängigen Ziel gespeichert werden.

## 23. Audit

Sicherheitsrelevante Aktionen werden protokolliert, zum Beispiel:

- Login
- Machine Enrollment
- Änderung einer Projektmitgliedschaft
- Secret-Änderung
- Secret-Projektion
- Workspace Provisioning
- Workspace Sync
- Coding Session
- Backup
- Restore

Secret-Werte gehören niemals in das Audit Log.

## 24. Optionale DevDeck AI

Eine eigene AI-Integration ist **nicht Bestandteil des notwendigen Cores**.

Sie kann später ergänzt werden für Funktionen wie:

- Ask DevDeck
- intelligente Projektzusammenfassungen
- Smart Project Preparation
- semantische Suche
- Decision-Vorschläge
- Vorschläge für nächste Schritte

Die wichtigste Regel bleibt:

> DevDeck muss vollständig funktionieren, wenn die DevDeck AI deaktiviert ist.

## 25. Source-of-Truth Übersicht

| Bereich | Source of Truth |
|---|---|
| Sourcecode | GitHub / GitLab |
| Code History | Git |
| Benutzer | DevDeck SQLite |
| Projekte | DevDeck SQLite |
| Berechtigungen | DevDeck SQLite |
| Maschinen | DevDeck SQLite |
| Workspace Registry | DevDeck SQLite |
| Tasks | DevDeck SQLite |
| Decisions | DevDeck SQLite |
| Changelog | DevDeck SQLite |
| Coding Sessions | DevDeck SQLite |
| Handovers | DevDeck SQLite |
| Secret Metadata | DevDeck SQLite |
| Secret Values | DevDeck Vault |
| Secret Files | DevDeck Vault |
| `.env` | lokal generiert |
| Dependencies | lokal reproduziert |
| Coding Context | lokal unter `.devdeck/` generiert |
| Production | jeweiliges Deployment-Ziel |
| Backups | konfiguriertes Backup-Ziel |

## 26. Roadmap

### Phase 1: DevDeck Server

- Linux-VM
- Web UI/API
- SQLite
- Login (Auth, Sessions, Audit)
- Benutzer und Systeme-Rollen (admin / developer)
- Projekte und Projektmitgliedschaften
- Machine Enrollment (Tokens, Revocation)
- Machine Registry (Heartbeat, Online-Status)
- WebApp
- MobileApp

### Phase 2: DevDeck Agent

- Windows Agent
- macOS Agent
- Linux Agent
- Machine Enrollment (CLI: `enroll`, `status`, `start`)
- Heartbeat
- Machine Registry
- Workspace Registry
- lokale Aktionen (Allowlist)

### Phase 3: Workspace Management

- Workspace Manifest
- Provision Workspace
- Sync Workspace
- Toolchain Check
- Dependency Setup
- Workspace Readiness

### Phase 4: Knowledge

- Tasks (Erstellen, Aktualisieren, Status, Complete, Cancel)
- Decisions
- Changelog
- vollständige History
- Sessions
- Handovers (strukturiert)
- Suche
- Cross-Machine Handover

### Phase 5: DevDeck Vault

- verschlüsselter Vault
- `.env` Projection
- Secret Files
- Projekt-/Environment-Berechtigungen
- Secret Audit
- Metadaten-Only-Exposure (keine Werte in API/Logs)

### Phase 6: CLI und Coding Agents

- DevDeck CLI
- Claude Code Launcher
- Codex Launcher
- Session Tracking
- strukturierte Handovers

### Phase 7: Backups

- DevDeck System Backup
- Vault Backup
- projektbezogene Backups
- Scheduling
- Retention
- Restore

### Phase 8: Service Integrations

Je nach Projektbedarf können Integrationen zu Git-, Hosting-, Backend- und weiteren Services ergänzt werden.

### Phase 9: Optionale DevDeck AI

Erst nachdem der deterministische Core stabil funktioniert.

## Status

DevDeck befindet sich aktuell in **Phase 1–4 + 6 (teilweise)**: Server mit Authentifizierung,
Benutzerverwaltung, Machine Enrollment, Workspace-Registry/-Provisioning/-Sync, Tasks, Coding
Sessions/Handovers, Coding-Context-Erzeugung und ein vollständig verdrahteter DevDeck Vault sind
funktionsfähig. Bewusst noch nicht umgesetzt: DevDeck CLI, Backups/Restore, eigene
Decisions/Changelog/Known-Issues-Verwaltung sowie Service-Integrationen – siehe
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) für den genauen Stand und die Hilfe-Seite
in der Web-UI für eine nutzerorientierte Erklärung. Nicht alle in diesem README beschriebenen
Funktionen sind bereits implementiert – es bleibt teils Zielbild.

## Versionshistorie

Die Versionshistorie und Änderungsprotokolle finden Sie im [CHANGELOG](CHANGELOG.md).
