/** DevDeck – Rollen- und Berechtigungssystem (Systemrolle ≠ Projektrolle). */
export type SystemRole = 'admin' | 'developer';
export type ProjectRole = 'owner' | 'maintainer' | 'developer' | 'viewer';

export const SYSTEM_ROLES: readonly SystemRole[] = ['admin', 'developer'] as const;
export const PROJECT_ROLES: readonly ProjectRole[] = [
  'owner',
  'maintainer',
  'developer',
  'viewer',
] as const;

/** Rangordnung für projektweite Rechtevergleiche (höher = mehr Rechte). */
const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 0,
  developer: 1,
  maintainer: 2,
  owner: 3,
};

export function projectRoleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Capability-basierte Secret-Rechte gemäß Spezifikation §14. */
export type SecretCapability =
  | 'secret.metadata.read'
  | 'secret.use'
  | 'secret.reveal'
  | 'secret.update'
  | 'secret.file.deploy';

export const SECRET_CAPABILITIES: readonly SecretCapability[] = [
  'secret.metadata.read',
  'secret.use',
  'secret.reveal',
  'secret.update',
  'secret.file.deploy',
] as const;

/**
 * Implizite Secret-Capabilities je Projektrolle (Entscheidung A13):
 * - owner/maintainer: alle Capabilities
 * - developer: metadata.read + use
 * - viewer: metadata.read
 * Explizite Grants (secret_grants) überschreiben diese Basis.
 */
export function implicitSecretCapabilities(role: ProjectRole): SecretCapability[] {
  switch (role) {
    case 'owner':
    case 'maintainer':
      return [...SECRET_CAPABILITIES];
    case 'developer':
      return ['secret.metadata.read', 'secret.use'];
    case 'viewer':
      return ['secret.metadata.read'];
  }
}

/** Environments für Projekte und Secrets. */
export type Environment = 'development' | 'staging' | 'production';
export const ENVIRONMENTS: readonly Environment[] = [
  'development',
  'staging',
  'production',
] as const;

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

export function isSystemRole(value: unknown): value is SystemRole {
  return typeof value === 'string' && (SYSTEM_ROLES as readonly string[]).includes(value);
}

export function isSecretCapability(value: unknown): value is SecretCapability {
  return (
    typeof value === 'string' && (SECRET_CAPABILITIES as readonly string[]).includes(value)
  );
}
