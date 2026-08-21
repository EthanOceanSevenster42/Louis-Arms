/* Accounts, and what each layer may reach.
 *
 * THE THREE LAYERS (Louis, 17 Aug 2026 - settled in shape):
 *   user   the inspector at the abattoir. Captures the monthly Schedule 8 for
 *          THEIR OWN abattoir only. Sees their own figures and how they compare
 *          with the province and the country. Cannot see another abattoir's
 *          detail, cannot approve, cannot change the register.
 *   admin  the regional manager / PEO / state vet. Everything a user can do,
 *          across every abattoir in THEIR PROVINCE. Approves submitted returns
 *          - the step that makes a figure count.
 *   super  national. Everything, plus the register, the disease list, and who
 *          has access.
 *
 * CAPTURE AND APPROVAL ARE NEVER THE SAME PERSON. That separation is the whole
 * value of the approval step, and it is why these are three layers rather than
 * one role with a flag. It is enforced in capture.js; this is where the layers
 * are defined.
 *
 * Every statement here binds its values. Nothing a person types is ever
 * concatenated into SQL - see `sql` in db.js.
 */
import { sql, query, raw, D } from '../db.js';
import { hashPassword, verifyPassword, needsRehash, generateTempPassword } from './passwords.js';
import { provinceOfRc, isProvince, PROVINCES } from '../rc.js';

export const ROLES = ['user', 'admin', 'super'];

export const ROLE_LABEL = {
  user: 'Inspector — one abattoir',
  admin: 'Regional manager — one province',
  super: 'Super user — national',
};

const USER_COLS = `
  UserId, Username, FullName, Email, PasswordHash, Role, ScopeOrgId, ScopeProvince,
  IsActive, MustChangePassword, FailedAttempts, LockedUntil, LegacyUsrId,
  CreatedAt, CreatedBy, LastLoginAt`;

function shape(r) {
  if (!r) return null;
  return {
    userId: Number(r.UserId),
    username: r.Username,
    fullName: r.FullName,
    email: r.Email || null,
    passwordHash: r.PasswordHash,
    role: r.Role,
    scopeOrgId: r.ScopeOrgId === null ? null : Number(r.ScopeOrgId),
    scopeProvince: r.ScopeProvince || null,
    isActive: Boolean(r.IsActive),
    mustChangePassword: Boolean(r.MustChangePassword),
    failedAttempts: Number(r.FailedAttempts),
    lockedUntil: r.LockedUntil || null,
    legacyUsrId: r.LegacyUsrId === null ? null : Number(r.LegacyUsrId),
    createdAt: r.CreatedAt,
    createdBy: r.CreatedBy || null,
    lastLoginAt: r.LastLoginAt || null,
  };
}

/* The column list is fixed text; only the value is bound. */
export async function findByUsername(username) {
  const rows = await sql`SELECT ${raw(USER_COLS)}
FROM arms.AppUser WHERE Username = ${String(username || '').trim().toLowerCase()}`;
  return shape(rows[0]);
}

export async function findById(userId) {
  const rows = await sql`SELECT ${raw(USER_COLS)}
FROM arms.AppUser WHERE UserId = ${Number(userId) || 0}`;
  return shape(rows[0]);
}

export async function listUsers() {
  const rows = await query(`SELECT ${USER_COLS} FROM arms.AppUser ORDER BY Role, Username`);
  return rows.map(shape);
}

export async function countUsers() {
  const [r] = await query('SELECT COUNT(*) AS n FROM arms.AppUser');
  return Number(r.n);
}

/* ---------------------------------------------------------------------------
 * Creating an account
 * ------------------------------------------------------------------------- */

export async function createUser({
  username, fullName, email, role, scopeOrgId = null, scopeProvince = null,
  password = null, createdBy = null, legacyUsrId = null, mustChangePassword = true,
}) {
  const problems = [];

  const uname = String(username || '').trim().toLowerCase();
  /* An e-mail address is a perfectly ordinary username and is what FSA uses,
   * so '@' and '+' are allowed alongside the original set. */
  if (!/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(uname)) {
    problems.push('username must be 3-64 characters: letters, digits, dot, dash, underscore, @ or +');
  }
  if (!String(fullName || '').trim()) {
    problems.push('a full name is required — an approval must be attributable to a person');
  }
  if (!ROLES.includes(role)) problems.push(`role must be one of ${ROLES.join(', ')}`);

  /* The scope must match the layer. The database enforces this too; checking
   * here as well means the person gets a sentence instead of a constraint. */
  if (role === 'user') {
    if (!scopeOrgId) problems.push('an inspector must be tied to one abattoir');
    scopeProvince = null;
  } else if (role === 'admin') {
    if (!isProvince(scopeProvince)) problems.push('a regional manager must be tied to one province');
    scopeOrgId = null;
  } else {
    scopeOrgId = null;
    scopeProvince = null;
  }

  if (password !== null) {
    problems.push(...passwordProblems(password));
  }

  if (problems.length) throw new Error(problems.join('; '));

  if (await findByUsername(uname)) throw new Error(`the username "${uname}" is already taken`);

  if (role === 'user') {
    const org = await sql`SELECT ORG_ID FROM ${raw(D.registry('Organisation'))}
                           WHERE ORG_ID = ${Number(scopeOrgId)}`;
    if (!org.length) throw new Error(`abattoir ${scopeOrgId} is not on the register`);
  }

  const temp = password || generateTempPassword();
  const hash = await hashPassword(temp);

  await sql`
INSERT INTO arms.AppUser
  (Username, FullName, Email, PasswordHash, Role, ScopeOrgId, ScopeProvince, MustChangePassword, LegacyUsrId, CreatedBy)
VALUES
  (${uname}, ${String(fullName).trim()}, ${email || null}, ${hash}, ${role},
   ${scopeOrgId === null ? null : Number(scopeOrgId)}, ${scopeProvince || null},
   ${mustChangePassword ? 1 : 0}, ${legacyUsrId === null ? null : Number(legacyUsrId)},
   ${createdBy || null})`;

  const created = await findByUsername(uname);
  /* Returned once, shown once, never stored in the clear. */
  return { user: created, temporaryPassword: password ? null : temp };
}

/* ---------------------------------------------------------------------------
 * Signing in
 * ------------------------------------------------------------------------- */

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/* A real hash of a value nobody knows. Verifying against it when the username
 * does not exist costs the same as a genuine check, so response time does not
 * reveal which usernames are real. Built once at load. */
const DUMMY_HASH = await hashPassword(generateTempPassword(6));

export async function authenticate(username, password) {
  const user = await findByUsername(username);

  if (!user) {
    await verifyPassword(String(password || ''), DUMMY_HASH);
    return { ok: false, reason: 'unknown-or-wrong' };
  }

  if (!user.isActive) {
    await verifyPassword(String(password || ''), DUMMY_HASH);
    return { ok: false, reason: 'disabled' };
  }

  if (user.lockedUntil && new Date(`${user.lockedUntil}Z`) > new Date()) {
    return { ok: false, reason: 'locked', until: user.lockedUntil };
  }

  const ok = await verifyPassword(String(password || ''), user.passwordHash);

  if (!ok) {
    const attempts = user.failedAttempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    if (lock) {
      await sql`UPDATE arms.AppUser
                   SET FailedAttempts = ${attempts},
                       LockedUntil = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${LOCK_MINUTES} MINUTE)
                 WHERE UserId = ${user.userId}`;
    } else {
      await sql`UPDATE arms.AppUser SET FailedAttempts = ${attempts}, LockedUntil = NULL
                 WHERE UserId = ${user.userId}`;
    }
    return {
      ok: false,
      reason: lock ? 'locked' : 'unknown-or-wrong',
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
    };
  }

  /* Raise the stored cost quietly if the parameters have moved on since this
   * password was set. */
  if (needsRehash(user.passwordHash)) {
    const fresh = await hashPassword(String(password));
    await sql`UPDATE arms.AppUser
                 SET PasswordHash = ${fresh}, FailedAttempts = 0, LockedUntil = NULL,
                     LastLoginAt = UTC_TIMESTAMP()
               WHERE UserId = ${user.userId}`;
  } else {
    await sql`UPDATE arms.AppUser
                 SET FailedAttempts = 0, LockedUntil = NULL, LastLoginAt = UTC_TIMESTAMP()
               WHERE UserId = ${user.userId}`;
  }

  return { ok: true, user: { ...user, failedAttempts: 0, lockedUntil: null } };
}

/* Length first. A long passphrase beats a short scramble, and these accounts
 * are issued to abattoir staff who will type them on a phone. */
export function passwordProblems(pw) {
  const s = String(pw || '');
  const out = [];
  if (s.length < 12) out.push('a password must be at least 12 characters');
  if (s.length > 200) out.push('a password must be under 200 characters');
  if (/^\s|\s$/.test(s)) out.push('a password must not start or end with a space');
  if (/^(.)\1+$/.test(s)) out.push('a password cannot be one repeated character');
  return out;
}

export async function setPassword(userId, newPassword, { mustChange = false } = {}) {
  const problems = passwordProblems(newPassword);
  if (problems.length) throw new Error(problems.join('; '));
  const hash = await hashPassword(newPassword);
  await sql`UPDATE arms.AppUser
               SET PasswordHash = ${hash}, MustChangePassword = ${mustChange ? 1 : 0},
                   FailedAttempts = 0, LockedUntil = NULL
             WHERE UserId = ${Number(userId)}`;
}

export async function setActive(userId, active) {
  await sql`UPDATE arms.AppUser SET IsActive = ${active ? 1 : 0} WHERE UserId = ${Number(userId)}`;
}

export async function resetPassword(userId) {
  const temp = generateTempPassword();
  await setPassword(userId, temp, { mustChange: true });
  return temp;
}

/* ---------------------------------------------------------------------------
 * SCOPE — which abattoirs a signed-in person may reach.
 *
 * A user sees their abattoir. An admin sees their province. A super user sees
 * the country. Both scopes already exist in the data, so nothing new is
 * invented here: the province comes from the first digit of the registration
 * certificate, exactly as every report derives it.
 * ------------------------------------------------------------------------- */

export async function scopedOrgIds(user) {
  if (!user) return [];
  if (user.role === 'super') return null;                 // null means "everything"
  if (user.role === 'user') return [user.scopeOrgId];

  /* An admin's province, from the certificate rather than the register's own
   * province column - the two disagree on six plants, and the certificate
   * wins. Using the register here would put an admin in charge of a plant no
   * report agrees is theirs. */
  const rows = await query(`
SELECT o.ORG_ID, LTRIM(RTRIM(a.ABA_RegistrationNumber)) AS RC
FROM ${D.registry('AbattoirMaster')} a
JOIN ${D.registry('Organisation')} o ON o.ORG_ID = a.ORG_ID`);

  const ids = [];
  for (const r of rows) {
    if (provinceOfRc(r.RC) === user.scopeProvince) ids.push(Number(r.ORG_ID));
  }
  return ids;
}

export async function mayReachOrg(user, orgId) {
  const ids = await scopedOrgIds(user);
  if (ids === null) return true;
  return ids.includes(Number(orgId));
}

export const canSeeAllDetail = (u) => Boolean(u) && (u.role === 'admin' || u.role === 'super');
export const canApprove = (u) => Boolean(u) && (u.role === 'admin' || u.role === 'super');
export const canCapture = (u) => Boolean(u);
export const canManageUsers = (u) => Boolean(u) && u.role === 'super';
export const canManageRegister = (u) => Boolean(u) && u.role === 'super';

/* A one-line description of what this person can reach, for the header. */
export function scopeLabel(user) {
  if (!user) return '';
  /* Counted from the province list the RC numbering defines, not written out
   * as a word. One place decides how many provinces there are. */
  if (user.role === 'super') {
    const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
                   'eight', 'nine', 'ten', 'eleven', 'twelve'];
    const n = PROVINCES.length;
    return `National — all ${words[n] || n} provinces`;
  }
  if (user.role === 'admin') return `${user.scopeProvince} — every abattoir in the province`;
  return 'One abattoir';
}
