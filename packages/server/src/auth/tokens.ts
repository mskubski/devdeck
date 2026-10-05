import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32-Byte-Zufallstoken (URL-sicher) für Sessions, Maschinen und Enrollment. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens werden nur gehasht persistiert (SHA-256). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Timing-sicherer Vergleich zweier Hex-Hashes. */
export function tokenHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Neuer Eindeutiger Slug aus einem Projektnamen. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'projekt';
}
