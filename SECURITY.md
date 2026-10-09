# Security Policy

DevDeck manages credentials and secret files, so security reports are taken seriously.

## Supported versions

DevDeck is in early development (0.x). Only the latest commit on `main` receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately using
GitHub's [**Report a vulnerability**](https://github.com/mskubski/devdeck/security/advisories/new)
feature (Security tab → *Report a vulnerability*).

Include, if possible: affected component (server, agent, web UI), steps to reproduce, impact, and
a suggested fix. You can expect an initial response within about a week. Please give us a
reasonable time to fix the issue before any public disclosure.

## Scope notes

- Never commit `.env`, `agent.json`, `data/` or `vault.key` files; if you did, rotate the affected
  secrets immediately.
- Run the server behind HTTPS (set `DEVDECK_SECURE_COOKIES=1`, and `DEVDECK_TRUST_PROXY=1` behind a
  reverse proxy).
- DevDeck has not had an independent security audit.
