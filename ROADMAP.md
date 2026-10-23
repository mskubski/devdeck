# Roadmap

> Checkbox-Liste für DevDeck. Wird mit `devdeck import tasks --apply` in das DevDeck-Projekt übernommen
> (bereits vorhandene Titel werden übersprungen). Priorität optional mit `(P1)`–`(P5)`.
> Details zum Umsetzungsstand: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Umgesetzt

- [x] Phase H: DevDeck CLI, Claude- und Codex-Launcher
- [x] Phase I: Backups, Restore und Retention (P5)
- [x] Phase E: Decisions, Changelog, Known Issues, History
- [x] Dependabot und npm audit in CI
- [x] Phase J: Konnektor-Interface und GitHub-Konnektor
- [x] Coding Sessions aus Claude Code automatisch erfassen (Transcript-Scanner im Agent)

## Offen

- [ ] Phase J: Service-Integrationen (Konnektoren)
- [ ] Konnektor GitLab (P2)
- [ ] Konnektor Supabase inkl. projektbezogenem DB-/Storage-Backup (P3)
- [ ] Konnektor Vercel (P2)
- [ ] Konnektor Brevo (P1)
- [ ] Konnektoren Apple App Store und Google Play (P1)
- [ ] Konnektor IONOS (P1)
- [ ] Claude-Code-Hooks (SessionStart/SessionEnd) für Live-Status laufender Sessions (P4)
- [ ] Agent als installierbares Paket (`devdeck-agent`-Kommando, Windows/macOS-Installer) (P3)
- [ ] Phase 9: Optionale DevDeck AI – muss mit AI = disabled voll funktionieren (P1)
