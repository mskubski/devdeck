# CLAUDE.md – DevDeck

Regeln für Claude Code in diesem Repository (gilt auf jeder Maschine, auf der DevDeck ausgecheckt ist).

## Nach jeder Code-Anpassung GitHub aktualisieren (wichtig)

DevDeck wird aus GitHub heraus ausgerollt: Der Server holt sich per Knopfdruck („System → Server aktualisieren“)
den Stand von `main`. Was nicht auf `main` ist, kommt nie auf den Server. Deshalb nach **jeder** abgeschlossenen
Code-Anpassung, ohne dass der Nutzer extra daran erinnern muss:

1. `npm run build && npm test` – nur bei grünem Ergebnis weiter.
2. Auf einem Feature-Branch committen (nie direkt auf `main`; `main` ist durch den Check `build-and-test` geschützt).
3. `git push -u origin HEAD`, Pull Request öffnen (`gh pr create --fill`).
4. CI abwarten (`gh pr checks --watch`) und bei grün mergen (`gh pr merge --merge`). Bei rotem CI: Fehler beheben,
   nicht umgehen (kein `--admin`, kein Force-Push, kein `--no-verify`).
5. Dem Nutzer am Ende sagen, dass der Stand auf `main` liegt und der Server jetzt per Knopf aktualisiert werden kann.

Der Server-Ordner auf debian01 ist zugleich ein Entwicklungs-Checkout: **keine uncommitteten Änderungen hinterlassen** –
das Server-Update bricht bei lokalen Änderungen an versionierten Dateien absichtlich ab.

## Weitere Regeln

- Nutzersichtbare Änderungen in `CHANGELOG.md` festhalten; Doku (README, `docs/ANLEITUNG.md`, Hilfe-Seite) bei Funktionsänderungen mitziehen.
- Keine Secrets committen (`.env`, `data/`, `agent.json`, Vault-Key).
- Restore von Backups nie selbst ausführen oder simulieren (nur ein Mensch im Terminal, siehe README).
- Sprache der UI und Doku: Deutsch; Code und Commit-Nachrichten: Englisch.
