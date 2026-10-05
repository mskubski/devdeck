import { AGENT_ACTIONS, type AgentAction, AppError } from '@devdeck/shared';
import type { ServerClient } from '../client.js';

/**
 * Action-Allowlist des Agenten (Spezifikation: KEINE generische Remote-Shell).
 * Nur Namen aus der zentralen Shared-Allowlist dürfen registriert werden.
 */
export interface ActionContext {
  client: ServerClient;
  payload: Record<string, unknown>;
  config: import('../config.js').AgentConfig;
}

export type ActionHandler = (ctx: ActionContext) => Promise<Record<string, unknown>>;

const handlers = new Map<string, ActionHandler>();

export function registerAction(name: AgentAction, handler: ActionHandler): void {
  if (!(AGENT_ACTIONS as readonly string[]).includes(name)) {
    throw new AppError('FORBIDDEN', `Aktion nicht in der Allowlist: ${name}`);
  }
  handlers.set(name, handler);
}

export function getAction(name: string): ActionHandler | undefined {
  return handlers.get(name);
}

export function hasAction(name: string): boolean {
  return handlers.has(name);
}

export function actionNames(): string[] {
  return [...handlers.keys()];
}
