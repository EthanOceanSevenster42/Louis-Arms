/* The audit trail.
 *
 * "Assume audit from the start. Who saw what matters less than who CHANGED
 * what, but a disease investigation may ask both."
 *
 * So: every write is recorded, and reads are not. A row per approval, per
 * submission, per correction, per account change - the things somebody may one
 * day have to answer for. Writing to the log never fails a request; a lost
 * audit line is bad, but refusing an approval because the log was busy is
 * worse, and the approval itself carries its own attribution on FormData.
 */
import { sql } from './db.js';

export const ACTIONS = {
  LOGIN: 'login',
  LOGIN_FAILED: 'login-failed',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'password-changed',
  PASSWORD_RESET: 'password-reset',
  USER_CREATED: 'user-created',
  USER_ENABLED: 'user-enabled',
  USER_DISABLED: 'user-disabled',
  RETURN_STARTED: 'return-started',
  RETURN_SAVED: 'return-saved',
  RETURN_SUBMITTED: 'return-submitted',
  RETURN_APPROVED: 'return-approved',
  RETURN_RETURNED: 'return-sent-back',
  RETURN_REVISED: 'return-revised',
};

export async function audit({
  user = null, action, entityType = null, entityId = null, detail = null, ip = null,
}) {
  try {
    await sql`
INSERT INTO arms.AuditLog (UserId, Username, Action, EntityType, EntityId, Detail, IpAddress)
VALUES (${user?.userId ?? null}, ${user?.username ?? null}, ${String(action)},
        ${entityType}, ${entityId === null ? null : String(entityId)},
        ${detail === null ? null : JSON.stringify(detail)}, ${ip})`;
  } catch (err) {
    /* Never let the trail break the work it is describing. */
    console.error(`  audit write failed (${action}): ${err.message}`);
  }
}

export async function recentAudit({ limit = 200, userId = null } = {}) {
  const rows = userId
    ? await sql`SELECT AuditId, At, UserId, Username, Action, EntityType, EntityId, Detail, IpAddress
                  FROM arms.AuditLog WHERE UserId = ${Number(userId)} ORDER BY At DESC, AuditId DESC
                  LIMIT ${Number(limit)}`
    : await sql`SELECT AuditId, At, UserId, Username, Action, EntityType, EntityId, Detail, IpAddress
                  FROM arms.AuditLog ORDER BY At DESC, AuditId DESC
                  LIMIT ${Number(limit)}`;

  return rows.map((r) => ({
    auditId: Number(r.AuditId),
    at: r.At,
    userId: r.UserId === null ? null : Number(r.UserId),
    username: r.Username,
    action: r.Action,
    entityType: r.EntityType,
    entityId: r.EntityId,
    detail: r.Detail ? safeParse(r.Detail) : null,
    ip: r.IpAddress,
  }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
