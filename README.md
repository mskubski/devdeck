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
          Machine registry · Audit log · Backups
```

| Component | Role |
|---|---|
| **Server** (`packages/server`) | Central web UI and API: users, projects, memberships, machine registry, tasks, coding sessions/handovers, encrypted secret vault, audit log |
| **Agent** (`packages/agent`) | Runs on each developer machine: enrolls with the server, sends heartbeats, executes commands (provision/sync workspaces, install dependencies, write coding context, project secrets) |
| **CLI** (`packages/cli`) | Planned developer-facing command line (not implemented yet) |
| **Shared** (`packages/shared`) | Protocol types, roles and errors shared by all components |

## Features

- Multi-user, multi-project with roles (owner, maintainer, developer, viewer)
- Machine enrollment and command queue between server and agents
- Workspace registry, `workspace.yaml` manifest, provisioning, sync and readiness checks
- Tasks, coding sessions and handovers between machines/people
- Generated coding context (`.devdeck/CONTEXT.md` and friends) for AI coding agents
- Encrypted vault (AES-256-GCM) for secret values and secret files, with per-capability access and auditing
- Plain HTML/CSS/JS web UI – no frontend build step
- Audit log for security-relevant actions

See [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for what is implemented and what is
still planned (CLI, backups/restore, service integrations).

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

See `packages/server/src/config.ts` for the complete list.

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
  cli/      Planned CLI
```

Further design documents (German): [DEVDECK_v5.md](docs/DEVDECK_v5.md),
[IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), [STRUKTUR.md](docs/STRUKTUR.md).

## Security

DevDeck handles credentials, so run it behind HTTPS (e.g. a reverse proxy) and keep the data
directory and vault key (`vault.key`) private and backed up. Never commit `.env`, `data/` or
`agent.json` files. This is early-stage software that has not had an independent security
audit – use at your own risk. See [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.

## Status

Early development (v0.1). APIs and the database schema may change without notice.

## License

[MIT](LICENSE) © 2026 Maurice Skubski
