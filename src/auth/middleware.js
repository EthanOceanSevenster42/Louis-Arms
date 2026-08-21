/* Who is asking, and may they.
 *
 * attachUser runs on every request and puts the signed-in person on req.user
 * (or null). Nothing else guesses - a route that needs a person asks for one.
 */
import crypto from 'node:crypto';
import { COOKIE_NAME, userForToken } from './sessions.js';
import { canApprove, canManageUsers, canManageRegister } from './users.js';
import { config } from '../config.js';

export async function attachUser(req, res, next) {
  try {
    req.user = await userForToken(req.cookies?.[COOKIE_NAME]) || null;
  } catch (err) {
    /* A database wobble must not look like a valid session. */
    console.error(`  session lookup failed: ${err.message}`);
    req.user = null;
  }
  res.locals.user = req.user;
  next();
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.get('accept')?.includes('application/json');
}

function deny(req, res, status, message) {
  if (wantsJson(req)) return res.status(status).json({ error: message });
  if (status === 401) {
    const back = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${back}`);
  }
  return res.status(status).render
    ? res.status(status).send(message)
    : res.status(status).send(message);
}

export function requireAuth(req, res, next) {
  if (!req.user) return deny(req, res, 401, 'Sign in to continue.');

  /* A temporary password is not an identity. Until it is changed the only
   * pages that answer are the password page itself and signing out. */
  if (req.user.mustChangePassword
      && !req.path.startsWith('/account/password')
      && !req.path.startsWith('/logout')) {
    return wantsJson(req)
      ? res.status(403).json({ error: 'Change your password before continuing.' })
      : res.redirect('/account/password?first=1');
  }

  next();
}

export const requireApprover = (req, res, next) =>
  canApprove(req.user) ? next()
    : deny(req, res, 403, 'Only a regional manager or a super user may approve a return.');

export const requireSuper = (req, res, next) =>
  canManageUsers(req.user) ? next()
    : deny(req, res, 403, 'Only a super user may do this.');

export const requireRegisterRights = (req, res, next) =>
  canManageRegister(req.user) ? next()
    : deny(req, res, 403, 'Only a super user may change the register.');

/* ---------------------------------------------------------------------------
 * CSRF.
 *
 * Every state-changing form carries a token that a third-party site cannot
 * read. SameSite=Lax on the session cookie already blocks the common
 * cross-site POST, but it is one browser default away from not doing so, and
 * the thing being protected here is an approval on a national animal-health
 * record. Double-submit: the token is a cookie AND a hidden field, and the two
 * must match.
 * ------------------------------------------------------------------------- */

export const CSRF_COOKIE = 'arms_csrf';

export function csrf(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];

  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,          // the form has to be able to carry it
      sameSite: 'lax',
      secure: config.http.secureCookies,
      path: '/',
    });
  }
  res.locals.csrfToken = token;
  req.csrfToken = token;

  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const sent = req.body?._csrf || req.get('x-csrf-token');
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(String(token));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    return wantsJson(req)
      ? res.status(403).json({ error: 'This form has expired. Reload the page and try again.' })
      : res.status(403).send('This form has expired. Go back, reload the page and try again.');
  }
  next();
}

/* The caller's address, for the audit trail. Behind a proxy the socket address
 * is the proxy, so X-Forwarded-For is read - but only when the server has been
 * told it is behind one, because otherwise the header is caller-supplied and
 * would let anybody write any address into the audit log. */
export function clientIp(req) {
  if (config.http.trustProxy) {
    const fwd = req.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  }
  return (req.socket?.remoteAddress || '').slice(0, 64) || null;
}
