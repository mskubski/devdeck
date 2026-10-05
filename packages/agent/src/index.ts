import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  AGENT_VERSION,
  defaultConfigPath,
  defaultWorkspaceRoot,
  loadAgentConfig,
  saveAgentConfig,
  type AgentConfig,
} from './config.js';
import { ServerClient } from './client.js';
import { startHeartbeat } from './heartbeat.js';
import { startWorker } from './worker.js';
import { startLocalApi } from './localApi.js';

interface CliArgs {
  command: 'start' | 'enroll' | 'status';
  server?: string;
  token?: string;
  name?: string;
  configPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: 'start', configPath: defaultConfigPath() };
  const [cmd, ...rest] = argv;
  if (cmd === 'enroll' || cmd === 'status' || cmd === 'start') args.command = cmd;
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === '--server' && value) {
      args.server = value;
      i += 1;
    } else if (key === '--token' && value) {
      args.token = value;
      i += 1;
    } else if (key === '--name' && value) {
      args.name = value;
      i += 1;
    } else if (key === '--config' && value) {
      args.configPath = value;
      i += 1;
    }
  }
  return args;
}

function ensureConfig(args: CliArgs): AgentConfig {
  const existing = loadAgentConfig(args.configPath);
  const config: AgentConfig = existing ?? {
    serverUrl: (args.server ?? process.env.DEVDECK_SERVER_URL ?? 'http://127.0.0.1:7400').replace(
      /\/+$/,
      '',
    ),
    machineId: null,
    machineToken: null,
    localToken: randomBytes(24).toString('base64url'),
    workspaceRoot: defaultWorkspaceRoot(),
    localPort: Number(process.env.DEVDECK_LOCAL_PORT ?? 7420),
    agentVersion: AGENT_VERSION,
  };
  if (args.server) config.serverUrl = args.server.replace(/\/+$/, '');
  return config;
}

async function runEnroll(args: CliArgs): Promise<void> {
  const config = ensureConfig(args);
  const token = args.token ?? process.env.DEVDECK_ENROLLMENT_TOKEN;
  if (!token) {
    console.error(
      'Enrollment-Token fehlt. Erzeuge es in der DevDeck Web UI oder per CLI:\n' +
        '  devdeck machine enroll-token\n' +
        'und starte dann:\n' +
        '  devdeck-agent enroll --server https://devdeck.example --token <TOKEN>',
    );
    process.exitCode = 1;
    return;
  }
  const name = args.name ?? process.env.DEVDECK_MACHINE_NAME ?? hostname();
  const client = new ServerClient(config);
  const result = await client.enroll(token, name);
  saveAgentConfig(config, args.configPath);
  console.log(`[DevDeck Agent] Registriert als Maschine ${result.machine_id}`);
  console.log(`[DevDeck Agent] Konfiguration: ${args.configPath}`);
}

async function runStart(args: CliArgs): Promise<void> {
  const config = ensureConfig(args);
  if (!config.machineToken || !config.machineId) {
    console.error(
      '[DevDeck Agent] Nicht enrolliert. Bitte zuerst ausführen:\n' +
        '  devdeck-agent enroll --server <URL> --token <Enrollment-Token>',
    );
    process.exitCode = 1;
    return;
  }
  saveAgentConfig(config, args.configPath);

  const local = startLocalApi(config);
  const heartbeat = startHeartbeat(config);
  const worker = startWorker(config);

  console.log(
    `[DevDeck Agent] läuft – Server: ${config.serverUrl}, Maschine: ${config.machineId}, ` +
      `Lokal: 127.0.0.1:${config.localPort}`,
  );

  const shutdown = (): void => {
    heartbeat.stop();
    worker.stop();
    void local.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'enroll') {
    await runEnroll(args);
    return;
  }
  if (args.command === 'status') {
    const config = ensureConfig(args);
    console.log(
      JSON.stringify(
        {
          server_url: config.serverUrl,
          enrolled: Boolean(config.machineToken),
          machine_id: config.machineId,
          config: args.configPath,
        },
        null,
        2,
      ),
    );
    return;
  }
  await runStart(args);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[DevDeck Agent] Fehler:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
