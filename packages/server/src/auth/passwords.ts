import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Passwort-Hashing mit scrypt (Entscheidung A4).
 * Format: scrypt$N$r$p$<salt-base64>$<hash-base64>
 *
 * Parameter: N=2^15, r=8, p=1 → ~32 MiB Speicher pro Hash, deutlich über
 * OWASP-Minimum (N=2^14) und praktikabel auf kleinen Self-Hosted-VMs.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 32;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Passwort muss mindestens 8 Zeichen lang sein');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!saltB64 || !hashB64 || !Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
