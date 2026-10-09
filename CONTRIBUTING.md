# Contributing to DevDeck

Thanks for your interest! DevDeck is in early development, so please open an issue to discuss
larger changes before investing time in a pull request.

## Setup

Requires Node.js >= 22.5.

```bash
git clone https://github.com/mskubski/devdeck.git
cd devdeck
npm install
npm run build
npm test
```

## Guidelines

- Keep pull requests focused; one topic per PR.
- Add or update tests (`vitest`) for behavior changes, and make sure `npm run build` and
  `npm test` pass – CI runs both.
- Never include real credentials, hostnames, personal data or `.env` files in code, tests or docs.
  Use placeholders such as `admin@example.com`.
- Secrets must never be written to logs, generated context files or API responses without the
  appropriate capability and an audit entry.
- Match the surrounding code style (TypeScript, ESM, no frontend build step for the web UI).
- Use clear commit messages in the imperative mood ("Add X", "Fix Y").

## Security issues

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
