/** DevDeck – gemeinsame Fehler-Codes (Agent-Protokoll & API). */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'CONFIRMATION_REQUIRED',
  'EXPIRED',
  'GIT_DIRTY',
  'GIT_CONFLICT',
  'GIT_UNREACHABLE',
  'AGENT_OFFLINE',
  'TOOL_MISSING',
  'DEP_FAILED',
  'MANIFEST_INVALID',
  'LOCKFILE_CHANGED',
  'SECRET_UNAVAILABLE',
  'VAULT_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFIRMATION_REQUIRED: 428,
  EXPIRED: 410,
  GIT_DIRTY: 409,
  GIT_CONFLICT: 409,
  GIT_UNREACHABLE: 502,
  AGENT_OFFLINE: 503,
  TOOL_MISSING: 424,
  DEP_FAILED: 424,
  MANIFEST_INVALID: 422,
  LOCKFILE_CHANGED: 409,
  SECRET_UNAVAILABLE: 404,
  VAULT_ERROR: 500,
  INTERNAL: 500,
};

/** Strukturierter DevDeck-Fehler – über API und Agent-Protokoll identisch. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (details !== undefined) this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** HTTP-Status für einen Fehlercode (hilfreich für Error-Mapping). */
export function httpStatusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
