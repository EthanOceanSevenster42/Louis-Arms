/* Password hashing.
 *
 * scrypt, from Node's own crypto module - no dependency, and a memory-hard KDF
 * rather than a bare hash. Parameters are stored inside the encoded string, so
 * they can be raised later without invalidating existing passwords: an old hash
 * still verifies against its own recorded cost, and is re-hashed at the next
 * successful login.
 *
 * THE LEGACY PASSWORDS ARE NOT REUSED. NAHDIS_FSA..Users carries 155 accounts
 * whose PasswordHash is 36-40 characters - a legacy ASP.NET scheme from 2016.
 * We do not know its salt or iteration count, we cannot verify it safely, and
 * carrying it forward would import a decade-old weakness into a national
 * system. ARMS issues its own credentials. The legacy user id is kept on the
 * ARMS account so an old return still attributes to the right person.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/* N=2^15 is the interactive-login figure from the scrypt paper's own guidance,
 * and costs roughly 100 ms here. r and p are the standard 8 and 1. */
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 };

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('a password is required');
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p,
    /* scrypt needs roughly 128*N*r bytes; Node's default cap is below that at
     * N=32768 and it throws without this. */
    maxmem: 256 * PARAMS.N * PARAMS.r,
  });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');

  let actual;
  try {
    actual = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
      maxmem: 256 * Number(N) * Number(r),
    });
  } catch {
    return false;
  }

  /* Constant time. A length check first, because timingSafeEqual throws on a
   * length mismatch and that throw would itself be a signal. */
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* True when a stored hash was made with weaker parameters than we now use, so
 * the caller can quietly re-hash on a successful login. */
export function needsRehash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

/* A readable one-time password for a new account. No look-alike characters:
 * these get read down a telephone to an abattoir, and 0/O and 1/l/I are how
 * that goes wrong. */
export function generateTempPassword(words = 3) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(words * 4);
  const out = [];
  for (let w = 0; w < words; w++) {
    let chunk = '';
    for (let i = 0; i < 4; i++) chunk += alphabet[bytes[w * 4 + i] % alphabet.length];
    out.push(chunk);
  }
  return out.join('-');
}
