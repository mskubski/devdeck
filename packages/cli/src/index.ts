#!/usr/bin/env node
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { CliError } from './client.js';
import type { Ctx, Io } from './io.js';
import { login, logout, whoami } from './commands/auth.js';
import { context, status, sync } from './commands/workspace.js';
import { changelog, decision, handover, secret, session, task } from './commands/knowledge.js';
import { isLauncher, launch } from './commands/launch.js';
import { importCmd } from './commands/import.js';
import { envRun } from './commands/envRun.js';

const HELP = `DevDeck CLI

  devdeck login [--server URL] [--email E]   Anmelden (Passwort per Prompt oder DEVDECK_PASSWORD)
  devdeck logout | whoami
  devdeck status                             Server, Agent, Projekt und Workspace
  devdeck sync                               Workspace synchronisieren (über lokalen Agent)
  devdeck context [--print]                  .devdeck/-Kontext aktualisieren
  devdeck session start [--goal "..."]       Coding Session starten
  devdeck session finish                     Aktive Session beenden
  devdeck handover import <datei.json>       Handover zur aktiven Session importieren
  devdeck task add <titel> [--priority 1-5]
  devdeck changelog add <text> [--version x]
  devdeck decision add <titel> [--rationale ...]
  devdeck secret list [--environment e]      Nur Metadaten, nie Werte
  devdeck claude|codex [--goal "..."] [-- args]
                                             Coding Agent im Workspace starten (Kontext + Session)
  devdeck import changelog|tasks|secrets|all [--apply]
                                             Bestehende CHANGELOG.md, ROADMAP/TODO.md, .env/credentials.md importieren
                                             (ohne --apply nur Vorschau; Secret-Werte werden nie angezeigt)
  devdeck env run [--environment e] -- <cmd> Befehl mit Secrets als Umgebungsvariablen

Allgemein: --project <slug> überschreibt die automatische Projekterkennung.`;

const COMMANDS: Record<string, (ctx: Ctx, argv: string[]) => Promise<number>> = {
  login,
  logout: (ctx) => logout(ctx),
  whoami: (ctx) => whoami(ctx),
  status,
  sync,
  context,
  session,
  handover,
  task,
  changelog,
  decision,
  secret,
  import: importCmd,
  env: async (ctx, argv) => {
    if (argv[0] !== 'run') throw new CliError('Aufruf: devdeck env run -- <befehl>', 'USAGE', 2);
    return envRun(ctx, argv.slice(1));
  },
};

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    ctx.io.out(HELP);
    return name ? 0 : 2;
  }
  const command = isLauncher(name)
    ? (c: Ctx, a: string[]) => launch(c, name, a)
    : COMMANDS[name];
  if (!command) {
    ctx.io.err(`Unbekannter Befehl: ${name}\n\n${HELP}`);
    return 2;
  }
  try {
    return await command(ctx, rest);
  } catch (err) {
    if (err instanceof CliError) {
      ctx.io.err(`Fehler: ${err.message}`);
      return err.exitCode;
    }
    ctx.io.err(`Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function terminalIo(): Io {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    prompt: (question, hidden = false) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) {
          const w = rl as unknown as { _writeToOutput: (s: string) => void };
          w._writeToOutput = (s: string) => {
            if (s.startsWith(question)) process.stdout.write(question);
          };
        }
        rl.question(question, (answer) => {
          rl.close();
          if (hidden) process.stdout.write('\n');
          resolve(answer);
        });
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { env: process.env, cwd: process.cwd(), io: terminalIo() }).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
