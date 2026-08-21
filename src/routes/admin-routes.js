/* Super-user pages: who has access, and who changed what.
 *
 * "Grants and removes access, and can see who did what." Third in the build
 * order, because only the super user touches it and there are few super users.
 */
import express from 'express';
import { requireAuth, requireSuper, clientIp } from '../auth/middleware.js';
import {
  listUsers, createUser, setActive, resetPassword, findById, ROLES, ROLE_LABEL,
} from '../auth/users.js';
import { revokeAllForUser, activeSessionCount } from '../auth/sessions.js';
import { audit, ACTIONS, recentAudit } from '../audit.js';
import { getFormDefinition } from '../form-definition.js';
import { PROVINCES } from '../rc.js';
import { page, esc, messages, csrfField } from '../pages.js';

export const adminRoutes = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

adminRoutes.use('/admin', requireAuth, requireSuper);

adminRoutes.get('/admin/users', wrap(async (req, res) => {
  const [users, def] = await Promise.all([listUsers(), getFormDefinition()]);
  const abaName = new Map(def.abattoirs.map(([id, name]) => [Number(id), name]));

  const sessions = await Promise.all(users.map((u) => activeSessionCount(u.userId)));

  res.type('html').send(page({
    title: 'Users', user: req.user, active: '/admin/users',
    body: `
<h1>Who has access</h1>
<p class="sub">Three layers. A user captures for one abattoir, an admin approves for one province,
a super user does everything nationally.</p>

${messages({
      ok: req.query.created
        ? `Account created. The temporary password is shown once, below — write it down now.`
        : req.query.done ? 'Done.' : null,
      bad: req.query.error || null,
    })}

${req.query.temp ? `<div class="msg warn"><b>Temporary password for ${esc(req.query.created || '')}</b><br>
  <code style="font-size:1.2rem">${esc(req.query.temp)}</code><br>
  <span class="tiny">It is not stored in readable form and cannot be shown again. They must change it
  at first sign-in.</span></div>` : ''}

<div class="scroll"><table>
<tr><th>Username</th><th>Name</th><th>Layer</th><th>Scope</th><th>Status</th><th class="n">Sessions</th><th>Last sign-in</th><th></th></tr>
${users.map((u, i) => `<tr>
  <td><code>${esc(u.username)}</code></td>
  <td>${esc(u.fullName)}</td>
  <td class="tiny">${esc(ROLE_LABEL[u.role])}</td>
  <td class="tiny muted">${esc(u.role === 'user'
      ? (abaName.get(u.scopeOrgId) || `Abattoir ${u.scopeOrgId}`)
      : u.role === 'admin' ? u.scopeProvince : 'National')}</td>
  <td>${u.isActive ? '<span class="pill approved">active</span>' : '<span class="pill">disabled</span>'}
      ${u.mustChangePassword ? '<span class="pill submitted">temp password</span>' : ''}</td>
  <td class="n">${sessions[i]}</td>
  <td class="tiny muted">${esc(u.lastLoginAt ? String(u.lastLoginAt).slice(0, 16).replace('T', ' ') : 'never')}</td>
  <td class="tiny">
    ${u.userId === req.user.userId ? '<span class="muted">you</span>' : `
    <form method="post" action="/admin/users/${u.userId}/active" style="display:inline">
      ${csrfField(req.csrfToken)}<input type="hidden" name="active" value="${u.isActive ? '0' : '1'}">
      <button type="submit" class="ghost tiny">${u.isActive ? 'Disable' : 'Enable'}</button></form>
    <form method="post" action="/admin/users/${u.userId}/reset" style="display:inline">
      ${csrfField(req.csrfToken)}<button type="submit" class="ghost tiny">Reset password</button></form>`}
  </td>
</tr>`).join('')}
</table></div>

<h2>Add someone</h2>
<form method="post" action="/admin/users" class="card">
  ${csrfField(req.csrfToken)}
  <div class="grid2">
    <div><label for="username">Username</label>
      <input id="username" name="username" required autocapitalize="none" spellcheck="false"></div>
    <div><label for="fullName">Full name</label>
      <input id="fullName" name="fullName" required
             placeholder="As it should appear against an approval"></div>
  </div>
  <div class="grid2">
    <div><label for="email">E-mail (optional)</label><input id="email" name="email" type="email"></div>
    <div><label for="role">Layer</label>
      <select id="role" name="role" required>
        ${ROLES.map((r) => `<option value="${r}">${esc(ROLE_LABEL[r])}</option>`).join('')}
      </select></div>
  </div>
  <div class="grid2">
    <div><label for="scopeOrgId">Abattoir — for an inspector only</label>
      <select id="scopeOrgId" name="scopeOrgId">
        <option value="">—</option>
        ${def.abattoirs.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}
      </select></div>
    <div><label for="scopeProvince">Province — for a regional manager only</label>
      <select id="scopeProvince" name="scopeProvince">
        <option value="">—</option>
        ${PROVINCES.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
      </select></div>
  </div>
  <div class="row"><button type="submit">Create account</button></div>
  <p class="tiny muted">A temporary password is generated and shown once. There is no self-registration,
  and no way to read a password back.</p>
</form>

<div class="note">Authentication is still the open design decision. These are ARMS's own accounts.
Users span FSA staff, abattoir staff and provincial government, and FSA's Microsoft 365 directory
covers only the first — so federating covers a third of the people and issuing accounts covers all
of them. This is the second, built so the first can replace it later.</div>`,
  }));
}));

adminRoutes.post('/admin/users', wrap(async (req, res) => {
  const { username, fullName, email, role, scopeOrgId, scopeProvince } = req.body || {};
  try {
    const { user, temporaryPassword } = await createUser({
      username, fullName, email: email || null, role,
      scopeOrgId: scopeOrgId ? Number(scopeOrgId) : null,
      scopeProvince: scopeProvince || null,
      createdBy: req.user.username,
    });
    await audit({
      user: req.user, action: ACTIONS.USER_CREATED, entityType: 'user', entityId: user.userId,
      detail: { username: user.username, role: user.role, scopeOrgId: user.scopeOrgId, scopeProvince: user.scopeProvince },
      ip: clientIp(req),
    });
    res.redirect(`/admin/users?created=${encodeURIComponent(user.username)}&temp=${encodeURIComponent(temporaryPassword)}`);
  } catch (err) {
    res.redirect(`/admin/users?error=${encodeURIComponent(err.message)}`);
  }
}));

adminRoutes.post('/admin/users/:id/active', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.userId) return res.redirect('/admin/users?error=You+cannot+disable+your+own+account.');

  const active = req.body.active === '1';
  await setActive(id, active);
  /* Disabling has to take effect now, not when a cookie expires. */
  if (!active) await revokeAllForUser(id);

  const target = await findById(id);
  await audit({
    user: req.user, action: active ? ACTIONS.USER_ENABLED : ACTIONS.USER_DISABLED,
    entityType: 'user', entityId: id, detail: { username: target?.username }, ip: clientIp(req),
  });
  res.redirect('/admin/users?done=1');
}));

adminRoutes.post('/admin/users/:id/reset', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const target = await findById(id);
  if (!target) return res.redirect('/admin/users?error=No+such+account.');

  const temp = await resetPassword(id);
  await revokeAllForUser(id);
  await audit({
    user: req.user, action: ACTIONS.PASSWORD_RESET, entityType: 'user', entityId: id,
    detail: { username: target.username }, ip: clientIp(req),
  });
  res.redirect(`/admin/users?created=${encodeURIComponent(target.username)}&temp=${encodeURIComponent(temp)}`);
}));

/* ---------------------------------------------------------------------------
 * The audit trail
 * ------------------------------------------------------------------------- */

adminRoutes.get('/admin/audit', wrap(async (req, res) => {
  const rows = await recentAudit({ limit: 300 });

  res.type('html').send(page({
    title: 'Audit', user: req.user, active: '/admin/audit',
    body: `
<h1>Who did what</h1>
<p class="sub">Every write is recorded: approvals, submissions, corrections, account changes.
Reads are not — a disease investigation may ask both, but this is the half that matters.</p>

${rows.length === 0 ? '<div class="card"><span>Nothing recorded yet.</span></div>' : `
<div class="scroll"><table>
<tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Detail</th><th>From</th></tr>
${rows.map((r) => `<tr>
  <td class="tiny muted">${esc(String(r.at).slice(0, 19).replace('T', ' '))}</td>
  <td class="tiny">${esc(r.username || '—')}</td>
  <td class="tiny"><code>${esc(r.action)}</code></td>
  <td class="tiny muted">${esc(r.entityType || '')}${r.entityId ? ` ${esc(r.entityId)}` : ''}</td>
  <td class="tiny muted">${esc(r.detail ? JSON.stringify(r.detail).slice(0, 120) : '')}</td>
  <td class="tiny muted">${esc(r.ip || '')}</td>
</tr>`).join('')}
</table></div>
<p class="tiny muted">Showing the most recent ${rows.length}.</p>`}`,
  }));
}));
