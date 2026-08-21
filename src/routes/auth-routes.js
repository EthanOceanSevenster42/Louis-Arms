/* Signing in, signing out, and changing a password. */
import express from 'express';
import { config } from '../config.js';
import { authenticate, setPassword, passwordProblems, findById } from '../auth/users.js';
import { createSession, revokeSession, revokeAllForUser, COOKIE_NAME } from '../auth/sessions.js';
import { requireAuth, clientIp } from '../auth/middleware.js';
import { audit, ACTIONS } from '../audit.js';
import { page, plainPage, esc, messages, csrfField } from '../pages.js';

export const authRoutes = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* Where someone lands. The explorer is the default - it is what they signed in
 * for, and it now carries the account controls itself.
 *
 * Only relative paths, and never back to /login. An open redirect on a login
 * page is how a convincing phishing link gets built. */
const LANDING = '/explorer';

function safeNext(value) {
  const s = String(value || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/login')) return LANDING;
  if (s === '/') return LANDING;
  return s;
}

function loginPage({ error = null, username = '', next = '/', csrf, notice = null }) {
  return plainPage({
    title: 'Sign in',
    body: `
${notice ? messages({ ok: notice }) : ''}
${error ? messages({ bad: error }) : ''}

<form method="post" action="/login" class="card">
  ${csrfField(csrf)}
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" autocapitalize="none"
         autocorrect="off" spellcheck="false" required value="${esc(username)}" autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <div class="row"><button type="submit" style="width:100%">Sign in</button></div>
</form>

<p class="tiny">Condemnation figures are commercially sensitive. Accounts are issued by a
super user — there is no self-registration, and there never should be.</p>`,
  });
}

authRoutes.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.type('html').send(loginPage({
    next: safeNext(req.query.next),
    csrf: req.csrfToken,
    notice: req.query.signedout ? 'You are signed out.' : null,
  }));
});

authRoutes.post('/login', wrap(async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const next = safeNext(req.body?.next);
  const ip = clientIp(req);

  const result = await authenticate(username, password);

  if (!result.ok) {
    /* One message for "no such user" and for "wrong password". Telling them
     * apart hands an attacker a list of real usernames. "Locked" is different
     * because the person needs to know why waiting will help. */
    const error = result.reason === 'locked'
      ? 'Too many attempts. This account is locked for 15 minutes.'
      : result.reason === 'disabled'
        ? 'That account is not active. A super user can re-enable it.'
        : 'That username and password do not match.';

    await audit({
      action: ACTIONS.LOGIN_FAILED, entityType: 'user', entityId: String(username).slice(0, 60),
      detail: { reason: result.reason }, ip,
    });

    return res.status(401).type('html').send(loginPage({
      error, username, next, csrf: req.csrfToken,
    }));
  }

  const { token, expiresInMs } = await createSession(result.user.userId, {
    hours: config.http.sessionHours, ip, userAgent: req.get('user-agent'),
  });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.http.secureCookies,
    maxAge: expiresInMs,
    path: '/',
  });

  await audit({ user: result.user, action: ACTIONS.LOGIN, ip });

  res.redirect(result.user.mustChangePassword ? '/account/password?first=1' : next);
}));

authRoutes.get('/logout', wrap(async (req, res) => {
  if (req.user) await audit({ user: req.user, action: ACTIONS.LOGOUT, ip: clientIp(req) });
  await revokeSession(req.cookies?.[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.redirect('/login?signedout=1');
}));

/* ---------------------------------------------------------------------------
 * Password
 * ------------------------------------------------------------------------- */

function passwordPage({ user, first, error = null, csrf }) {
  const shell = first
    ? (opts) => plainPage(opts)
    : (opts) => page({ ...opts, user, active: '', wide: false });

  return shell({
    title: 'Change password',
    body: `
<h1 style="font-size:18px;margin-bottom:2px">Choose a password</h1>
<p class="sub">${first
  ? 'This account was issued a temporary password. Set your own before going further.'
  : 'Changing your password signs you out everywhere else.'}</p>

${error ? messages({ bad: error }) : ''}

<form method="post" action="/account/password" class="card">
  ${csrfField(csrf)}
  <input type="hidden" name="first" value="${first ? '1' : ''}">
  ${first ? '' : `<label for="current">Current password</label>
  <input id="current" name="current" type="password" autocomplete="current-password" required>`}
  <label for="pw">New password</label>
  <input id="pw" name="password" type="password" autocomplete="new-password" required autofocus>
  <label for="pw2">New password again</label>
  <input id="pw2" name="confirm" type="password" autocomplete="new-password" required>
  <div class="row"><button type="submit">Save</button>
    ${first ? '<a class="btn ghost" href="/logout">Sign out</a>' : '<a class="btn ghost" href="/explorer">Cancel</a>'}</div>
</form>

<p class="tiny">At least 12 characters. A phrase you can remember and type on a phone beats
a short scramble you will write on a note.</p>`,
  });
}

authRoutes.get('/account/password', requireAuth, (req, res) => {
  res.type('html').send(passwordPage({
    user: req.user, first: Boolean(req.query.first) || req.user.mustChangePassword, csrf: req.csrfToken,
  }));
});

authRoutes.post('/account/password', requireAuth, wrap(async (req, res) => {
  const { password = '', confirm = '', current = '' } = req.body || {};
  const first = Boolean(req.body?.first) || req.user.mustChangePassword;
  const fail = (error) => res.status(400).type('html')
    .send(passwordPage({ user: req.user, first, error, csrf: req.csrfToken }));

  /* Someone who already has a password proves they know it. Someone still on a
   * temporary one has already proved it by signing in with it. */
  if (!first) {
    const check = await authenticate(req.user.username, current);
    if (!check.ok) return fail('That is not your current password.');
  }

  if (password !== confirm) return fail('The two passwords do not match.');

  const problems = passwordProblems(password);
  if (problems.length) return fail(problems.join('; '));

  const fresh = await findById(req.user.userId);
  if (!fresh) return fail('That account no longer exists.');

  await setPassword(req.user.userId, password, { mustChange: false });
  await audit({ user: req.user, action: ACTIONS.PASSWORD_CHANGED, ip: clientIp(req) });

  /* Every other device is signed out; this one gets a new session so the
   * person is not bounced back to the login page after succeeding. */
  await revokeAllForUser(req.user.userId);
  const { token, expiresInMs } = await createSession(req.user.userId, {
    hours: config.http.sessionHours, ip: clientIp(req), userAgent: req.get('user-agent'),
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax', secure: config.http.secureCookies, maxAge: expiresInMs, path: '/',
  });

  res.redirect(`${LANDING}?changed=1`);
}));
