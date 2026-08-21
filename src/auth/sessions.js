/* Sessions.
 *
 * The cookie carries a random token; the database stores only its SHA-256. A
 * copy of the session table is therefore not a set of usable cookies, and a
 * super user removing an account can end that person's session immediately
 * rather than waiting for a cookie to expire. "Grants and removes access" has
 * to mean now, not in eight hours.
 */
import crypto from 'node:crypto';
import { sql, query } from '../db.js';
import { findById } from './users.js';

export const COOKIE_NAME = 'arms_session';

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export async function createSession(userId, { hours = 8, ip = null, userAgent = null } = {}) {
  /* 32 bytes from the CSPRNG. base64url so it survives a cookie unescaped. */
  const token = crypto.randomBytes(32).toString('base64url');

  await sql`
INSERT INTO arms.Session (TokenHash, UserId, ExpiresAt, IpAddress, UserAgent)
VALUES (${hashToken(token)}, ${Number(userId)},
        DATEADD(hour, ${Number(hours)}, SYSUTCDATETIME()),
        ${ip}, ${userAgent ? String(userAgent).slice(0, 300) : null})`;

  return { token, expiresInMs: hours * 3600 * 1000 };
}

/* Returns the signed-in user, or null. Also refreshes LastSeenAt so an idle
 * session can be recognised later. */
export async function userForToken(token) {
  if (!token) return null;

  const rows = await sql`
SELECT SessionId, UserId
FROM arms.Session
WHERE TokenHash = ${hashToken(token)}
  AND RevokedAt IS NULL
  AND ExpiresAt > SYSUTCDATETIME()`;

  if (!rows.length) return null;

  const user = await findById(rows[0].UserId);
  /* An account disabled mid-session stops working at the next request, not at
   * the next login. */
  if (!user || !user.isActive) {
    await revokeSession(token);
    return null;
  }

  await sql`UPDATE arms.Session SET LastSeenAt = SYSUTCDATETIME() WHERE SessionId = ${rows[0].SessionId}`;
  return { ...user, sessionId: Number(rows[0].SessionId) };
}

export async function revokeSession(token) {
  if (!token) return;
  await sql`UPDATE arms.Session SET RevokedAt = SYSUTCDATETIME()
             WHERE TokenHash = ${hashToken(token)} AND RevokedAt IS NULL`;
}

/* Used when an account is disabled or its password is reset - every device
 * that person is signed in on stops at once. */
export async function revokeAllForUser(userId) {
  await sql`UPDATE arms.Session SET RevokedAt = SYSUTCDATETIME()
             WHERE UserId = ${Number(userId)} AND RevokedAt IS NULL`;
}

export async function activeSessionCount(userId) {
  const [r] = await sql`
SELECT COUNT(*) AS n FROM arms.Session
WHERE UserId = ${Number(userId)} AND RevokedAt IS NULL AND ExpiresAt > SYSUTCDATETIME()`;
  return Number(r.n);
}

/* Expired rows are evidence of nothing and grow without limit. Cleared on a
 * timer by the server. The audit trail lives in arms.AuditLog, not here, so
 * removing a long-dead session loses nothing. */
export async function purgeExpiredSessions({ olderThanDays = 30 } = {}) {
  const rows = await sql`
DELETE FROM arms.Session
WHERE ExpiresAt < DATEADD(day, -${Number(olderThanDays)}, SYSUTCDATETIME());
SELECT @@ROWCOUNT AS n`;
  return Number(rows[0]?.n || 0);
}
