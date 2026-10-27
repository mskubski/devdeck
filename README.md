# DevDeck

[![CI](https://github.com/mskubski/devdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/mskubski/devdeck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

**A self-hosted developer control plane for multiple developers, projects and machines.**

> Git manages your code. DevDeck manages everything around it: projects, knowledge,
> workspaces, secrets and development workflows. The actual development stays on each
> developer's own machine.

*Deutsche Fassung des ausführlichen Konzepts: [README.de.md](README.de.md)*

## Why DevDeck?

When you develop on several PCs, Macs or Linux machines, a project is more than the contents of
a Git repository. You also need local dependencies, `.env` files, credentials, toolchains,
project context and the notes from previous coding sessions.

DevDeck makes a workspace on a new or different machine reproducibly ready to work – without
syncing source code through a file-sync service or a proprietary mechanism.

## Architecture

```text
                    GitHub / GitLab (source code)
                              |
          +-------------------+-------------------+
          |                                       |
   Developer machine A                     Developer machine B
   DevDeck Agent + CLI                     DevDeck Agent + CLI
          |                                       |
          +-------------------+-------------------+
                              |
                        DevDeck Server
              Web UI / API · SQLite · Vault
        Users & roles · Tasks · Sessions & handovers
          Decisions · Changelog · Known issues
          Machine registry · Audit log · Backups
```

| Component | Role |
|---|---|
| **Server** (`packages/server`) | Central web UI and API: users, projects, memberships, machine registry, tasks, decisions/changelog/known issues, coding sessions/handovers, encrypted secret vault, system backups, service connectors, audit log |
| **Agent** (`packages/agent`) | Runs on each developer machine: enrolls with the server, sends heartbeats, executes commands (provision/sync workspaces, install dependencies, write coding context, project secrets) |
| **CLI** (`packages/cli`) | Developer-facing command line (`devdeck login|status|sync|context|session|handover|task|changelog|decision|secret|env run|claude|codex`) |
| **Shared** (`packages/shared`) | Protocol types, roles and errors shared by all components |

## Features

- Multi-user, multi-project with roles (owner, maintainer, developer, viewer)
- Machine enrollment and command queue between server and agents; per-machine detail page with an automatically collected inventory (disks, device, OS, security status, CPU, BIOS, memory modules, network connections for Windows/Linux/macOS) and an installed-software list (registry on Windows, dpkg/rpm/pacman/snap/flatpak on Linux, system_profiler/Homebrew on macOS) and a patch status (pending OS updates and outdated apps: Windows Update + winget, apt/dnf/checkupdates, softwareupdate/Homebrew; critical/security/update, reboot hint, recently installed updates) and the latest system error logs (Windows Event Log, journald/dmesg, macOS unified log and crash reports; critical/error only, kept 30 days, capped per machine) and free custom fields
- Workspace registry, `workspace.yaml` manifest, provisioning, sync and readiness checks
- Per-workspace **Deploy** for software that runs on a machine (Linux, systemd user units): fast-forward to the branch, restart the services listed in `.devdeck/workspace.yaml`, health check, automatic rollback
- Tasks, decisions, changelog, known issues and a project history timeline
- Architecture map on the project dashboard: development machines → GitHub → hosting → database → external services (mail, Telegram, LLM providers, maps …) with descriptions and relations; detected automatically (env var names, hosts without credentials, dependencies, hosting files, SQLite sizes), described in a versioned `.devdeck/architecture.yaml` that Claude Code keeps up to date, and editable in the UI
- Coding sessions and handovers between machines/people; Claude Code sessions (CLI and desktop) are picked up automatically by the agent (metadata only)
- Generated coding context (`.devdeck/CONTEXT.md` and friends) for AI coding agents
- Encrypted vault (AES-256-GCM) for secret values and secret files, with per-capability access and auditing
- `devdeck` CLI (status, sync, sessions, handovers, `env run`) and launchers for Claude Code / Codex (`devdeck claude`, `devdeck codex`)
- System backups (database + encrypted vault) with verification, retention and a scheduler; restore is terminal-only by design
- Service connectors with vault-backed credentials (GitHub first)
- Plain HTML/CSS/JS web UI – no frontend build step
- Audit log for security-relevant actions

See [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for what is implemented and what is
still planned (further service connectors: GitLab, Supabase, Vercel, Brevo, Apple, Google Play, IONOS).

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite`)
- npm

## Quick start

```bash
git clone https://github.com/mskubski/devdeck.git
cd devdeck
npm install
npm run build

# The initial admin is only created on first start, when the database is empty.
export DEVDECK_ADMIN_EMAIL="admin@example.com"
export DEVDECK_ADMIN_PASSWORD="<choose-a-strong-password>"
export DEVDECK_HOST=127.0.0.1      # use 0.0.0.0 to expose to your network
export DEVDECK_PORT=8080
npm run server
```

Open <http://localhost:8080> (or your `DEVDECK_PORT`) and log in. Change the password after the first login.
`./start.sh` bundles these steps for a Linux server (build, start, health check); see
[ANLEITUNG.md](docs/ANLEITUNG.md) (German) for details on enrolling agents.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `DEVDECK_HOST` | `127.0.0.1` | Interface the server binds to |
| `DEVDECK_PORT` | `8080` | HTTP port |
| `DEVDECK_DATA_DIR` | `./data` | SQLite database, vault and runtime data |
| `DEVDECK_ADMIN_EMAIL` / `DEVDECK_ADMIN_PASSWORD` | – | Bootstrap admin on first start |
| `DEVDECK_BACKUP_TARGET` | `<data dir>/backups` | Backup target – use a path independent of the data dir (e.g. NAS) |
| `DEVDECK_BACKUP_INTERVAL_HOURS` | `24` | Automatic backup interval (`0` disables) |
| `DEVDECK_BACKUP_RETENTION_DAILY` / `_WEEKLY` | `7` / `4` | Daily and weekly backups to keep |

See `packages/server/src/config.ts` for the complete list.

### Development workflow (PC → GitHub → server)

Code only travels via GitHub; DevDeck never transfers source code itself.

1. Develop on any machine registered in DevDeck (e.g. with Claude Code) in a registered workspace – the agent picks the session up automatically.
2. **After every code change, GitHub is updated** (rule in [`CLAUDE.md`](CLAUDE.md), done by Claude Code): build + test, feature branch, push, pull request with auto-merge (GitHub merges as soon as CI is green).
3. In the web UI open **System → Update server**: it creates a backup, fast-forwards to `main`, runs `npm ci` + build and restarts the server (systemd). On any failure the previous version stays active.
4. By default the same click also tells all online agents (≥ 0.2.0) to update themselves; older agents need a one-time manual update. Sync workspaces afterwards (**Sync** / `devdeck sync`).
5. Optional, off by default: **System → Automatic update** updates server and agents once a night (default 03:00 server time) when `main` is newer – only with a clean checkout, after a backup, at most once a day.

The very first time, update the server by hand so it has the button:
`git checkout main && git pull --ff-only && npm ci && npm run build && systemctl --user restart devdeck-server devdeck-agent`.
See [ANLEITUNG.md](docs/ANLEITUNG.md) (German, section 9) for details. Target branch: `DEVDECK_UPDATE_BRANCH` (default `main`).

### GitHub issue sync

With a GitHub connector (token in the vault, "Issues: read and write"), **Integrations → Turn on issue sync** keeps DevDeck's tasks and known issues and the repository's GitHub Issues in sync in both directions
(local changes within seconds, GitHub changes polled every 5 minutes or via "Sync now"). Tasks are issues without the labels `bug`/`known-issue`, known issues are issues with `bug` or `known-issue`.
DevDeck only manages the labels `P1`–`P5`, `in-progress`, `known-issue` and `severity-low|medium|high` (plus title, body, open/closed); other labels, comments and assignees are left alone. If both sides changed the same item, GitHub wins.
Off by default; turning it on asks for confirmation and creates at most 50 issues per run.

### Project tabs

Every project has the same tabs; together they are the project's memory and are partly fed into the generated coding context (`.devdeck/CONTEXT.md`, `CURRENT_STATE.md`, `CHANGELOG_RECENT.md`) that coding agents read at the start of a session.

| Tab | Purpose | Write access |
|---|---|---|
| Overview | Key figures, project info, latest coding sessions and the architecture map | project edit: maintainer |
| Members | Who has access, with which role (viewer, developer, maintainer, owner) | maintainer |
| Tasks | Task list with priority 1–5 and status open → in progress → done (or cancelled); open tasks go into the coding context | maintainer |
| Decisions | Log of important decisions with rationale, context and rejected alternative (architecture decision records): *proposed* → *accepted*/*rejected* → optionally *superseded*; the 15 newest accepted ones go into the coding context | propose: developer, rate: maintainer |
| Changelog | Chronicle of changes (summary, optional version/details); manual, `devdeck changelog` or imported from `CHANGELOG.md` | developer |
| Known Issues | Known unresolved problems with severity and open/resolved status; open ones go into the coding context | developer |
| History | Read-only timeline across changelog, decisions, issues, tasks and sessions (latest 200 events) | – |
| Sessions | Coding sessions with handovers; Claude Code sessions on registered workspaces appear automatically (metadata only) | developer |
| Secrets | Encrypted vault entries per environment (development/staging/production) | maintainer |
| Workspaces | Working copies on machines: check, sync, import, provision, deploy | developer (import/deploy/remove: maintainer) |
| Integrations | Connectors to external services (GitHub first); the token lives in the vault | maintainer |
| Sync log | History of sync, provision and deploy jobs with errors | – |

### Adding a machine

**Machines → Add machine** creates a one-time enrollment token and opens an install dialog: pick the OS (Windows, Linux, macOS) and either download an install script (`install-devdeck-agent.ps1` / `.sh`) or copy the commands. The script checks git and Node.js ≥ 22.5, asks for install folder, workspace root, machine name and whether to start the agent at login/boot, then clones, builds, enrolls, sets up autostart and starts the agent. Scripts are generated in the browser; the token is not stored. The agent CLI also offers `autostart on|off|status` and `start-background`.

### Installing patches

On a machine's **Patches** tab pending updates can be installed one by one or several at once (Windows Update Agent + winget, apt/dnf, softwareupdate + Homebrew). The agent only installs what a fresh scan reports as pending (allowlisted action `patches.install`, strictly validated ids, no shell). A required **reboot is never performed**, only shown. Needs agent 0.15.0, owner/admin, and elevated rights on the machine (Windows: agent run as administrator; Linux/macOS: root or passwordless sudo). Machines with pending security updates show a shield alert in the top bar.

### Agent autostart

The **Autostart** toggle next to every machine (and on its detail page) adds the agent to or removes it from the machine's autostart, without admin rights: Windows per-user Run entry (hidden window), Linux systemd user unit `devdeck-agent.service` (for start without login: `sudo loginctl enable-linger $USER`), macOS LaunchAgent `de.devdeck.agent` (takes effect at next login). The running agent is never stopped or started twice. Needs agent 0.14.0; owner/admin only; audited.

### Deploying a project that runs on a machine

For software that runs productively on a registered Linux machine (e.g. a Python service as systemd *user* units), **Projects → Workspaces → Deploy** (maintainers, agent ≥ 0.8.0) does what you would otherwise do by hand:
requires a clean working copy, fast-forwards to the workspace branch (else the project's default branch), reads the `deploy` block of the versioned `.devdeck/workspace.yaml`, optionally runs the install command (only if there was new code),
restarts the listed units one after another and checks them (HTTP 2xx on a localhost URL, otherwise `systemctl --user is-active`). If a step fails or a service is unhealthy, the workspace is reset to the previous commit and the services are restarted with it.
Each step is shown in the dialog and in the **Sync-Log** tab; only units from the manifest are ever restarted – no free-form commands.

```yaml
deploy:
  timeout_seconds: 60
  install: .venv/bin/pip install -r requirements.txt   # optional, no shell characters
  services:
    - unit: my-api
      health_url: http://localhost:5001/health          # localhost only
    - unit: my-worker                                   # no URL: is-active
```

Projects deployed to Vercel via a Git push don't need this. Typical abort: *„lokale Änderungen“* – the message names the files; commit or remove them on the machine.

### Backups and restore

Admins can create and verify system backups in the web UI (**Backups**); the vault key is never included –
store it separately. Restoring overwrites production data and is therefore only possible interactively in a
terminal (stop the server first): `node packages/server/dist/restore.js <backup-dir>`.

### Importing existing project data

**Projects → Workspaces → Import** (maintainers): the agent reads `CHANGELOG.md`, `ROADMAP.md`/`TODO.md`, `.env` and `credentials.md` in the
workspace, shows a preview (secret names, never values) and imports changelog entries, tasks and secrets (encrypted in the vault, chosen environment)
after confirmation. Safe to repeat. Environments: *development* = local work with test values (the only one DevDeck writes into a workspace `.env` by default), *staging* = rehearsal environment mirroring live with test data, *production* = live operation with the real keys and accounts. Workspace sync also writes the generated context to `.devdeck/` and coding rules to `.claude/rules/devdeck.md`
(both locally git-excluded, so the repository stays clean); put `<!-- devdeck:rules-included -->` in your `CLAUDE.md` to opt out.

### CLI

```bash
node packages/cli/dist/index.js login --server http://localhost:8080
node packages/cli/dist/index.js status
node packages/cli/dist/index.js claude --goal "Fix the login bug"   # or: codex
```

Run `devdeck help` for all commands. `devdeck import all [--apply]` imports an existing `CHANGELOG.md`, `ROADMAP.md`/`TODO.md` and `.env`/`credentials.md` into a project (preview by default). The project is detected from `--project`, `.devdeck/project.json`
or the registered workspace path.

## Development

Contributions are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run build       # tsc -b
npm test            # vitest
npm run typecheck
```

Project layout:

```text
packages/
  server/   HTTP API, SQLite schema, vault, web UI (src/webui)
  agent/    Machine agent and workspace actions
  shared/   Shared protocol types
  cli/      DevDeck CLI
```

Further design documents (German): [DEVDECK_v5.md](docs/DEVDECK_v5.md),
[IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), [STRUKTUR.md](docs/STRUKTUR.md).

## Security

DevDeck handles credentials, so run it behind HTTPS (e.g. a reverse proxy) and keep the data
directory and vault key (`vault.key`) private and backed up. Never commit `.env`, `data/` or
`agent.json` files. This is early-stage software that has not had an independent security
audit – use at your own risk. See [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.

## Status

Early development (v0.1). Phases A–I and the GitHub connector of phase J are implemented. APIs and the database schema may change without notice.

## License

[MIT](LICENSE) © 2026 Maurice Skubski
