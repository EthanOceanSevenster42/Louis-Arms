/* ARMS backend.
 *
 * Serves the two applications in "1 - The system" over HTTP, reads every value
 * live from the SQL Server databases restored out of "3 - The database", and
 * now writes returns back into them behind a login.
 *
 * THE THREE LAYERS, and they are the whole point of the login:
 *   user   the inspector - captures for their own abattoir, sees their own
 *          figures against the province and national averages, and never
 *          another plant's detail
 *   admin  the regional manager - everything across their province, and the
 *          approval that turns a submission into a counted figure
 *   super  national - the register, the disease list, and who has access
 *
 * The offline files stay exactly as they are and are still downloadable. An
 * inspector in an abattoir office with no signal must still be able to open a
 * file and work.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';

import { config, baseUrl, validateConfig } from './config.js';
import { loadSettings } from './settings.js';
import { getPool, query, D, closePool } from './db.js';
import { getExplorerPayload, clearCache, cacheStatus } from './explorer-data.js';
import { getFormDefinition, clearFormCache } from './form-definition.js';
import { renderExplorer, renderMobile } from './render.js';
import { scopePayload, scopeRegister } from './scope.js';

import { attachUser, requireAuth, csrf, clientIp } from './auth/middleware.js';
import { scopedOrgIds, countUsers, canApprove, scopeLabel } from './auth/users.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { authRoutes } from './routes/auth-routes.js';
import { captureRoutes } from './routes/capture-routes.js';
import { adminRoutes } from './routes/admin-routes.js';
import { STATUS, listReturns, countReturns, loadFormIndex } from './capture.js';
import { page, esc, messages, statusPill } from './pages.js';
import { audit, ACTIONS } from './audit.js';
import { askQuestion, myQuestions, countOpenQuestions } from './questions.js';

const app = express();
app.disable('x-powered-by');
if (config.http.trustProxy) app.set('trust proxy', true);

/* extended:true so the capture desk's sl[Cattle] and of[Cattle][Cond][Livers]
 * fields arrive as nested objects rather than flat strings. */
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use(csrf);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* Browsers ask for /favicon.ico without being told to, on every page including
 * the sign-in page, and with nothing here that was a 404 in the console of an
 * otherwise clean application - the sort of noise that trains people to ignore
 * the console. It is answered before the authentication gate because the
 * request arrives before anyone has signed in, and it carries no figures. */
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect width="32" height="32" rx="7" fill="#123a2c"/>'
  + '<path d="M16 7 L23.5 25 H19.6 L18.2 21.2 H13.8 L12.4 25 H8.5 Z '
  + 'M16 12.4 L14.6 18 H17.4 Z" fill="#ffffff"/></svg>';

app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=604800').send(FAVICON);
});

/* Health is the one route that answers without a session - it is what you
 * check when nothing else works, and it exposes no figures. */
app.get('/api/health', wrap(async (req, res) => {
  const out = {
    ok: false,
    server: config.sql.server,
    databases: config.databases,
    fromYear: config.arms.fromYear,
    cache: cacheStatus(),
    signedIn: Boolean(req.user),
  };
  try {
    await getPool();
    const rows = await query(`
SELECT (SELECT COUNT(*) FROM ${D.data('FormData')}) AS returns,
       (SELECT COUNT(*) FROM ${D.data('FormData')} WHERE FRMD_Status='Approved') AS approved,
       (SELECT COUNT(*) FROM ${D.data('FormData')} WHERE FRMD_Status='Submitted') AS awaitingApproval,
       (SELECT COUNT(*) FROM ${D.data('FormData')} WHERE FRMD_Status='Superseded') AS superseded,
       (SELECT COUNT(*) FROM ${D.data('FormDataItems')}) AS items,
       (SELECT COUNT(*) FROM ${D.data('FormDataItemParts')}) AS parts,
       (SELECT COUNT(*) FROM ${D.registry('AbattoirMaster')}) AS abattoirs,
       (SELECT DATE_FORMAT(MIN(FRMD_StartDate), '%Y-%m') FROM ${D.data('FormData')}) AS firstPeriod,
       (SELECT DATE_FORMAT(MAX(FRMD_StartDate), '%Y-%m') FROM ${D.data('FormData')}) AS lastPeriod`);
    out.ok = true;
    out.counts = rows[0];
    out.accounts = await countUsers().catch(() => null);
    res.json(out);
  } catch (err) {
    out.error = err.message;
    res.status(503).json(out);
  }
}));

app.use(authRoutes);

/* Everything past this point needs a person. */
app.use(requireAuth);

app.use(captureRoutes);
app.use(adminRoutes);

/* ---------------------------------------------------------------------------
 * The two applications, scoped to whoever is looking
 * ------------------------------------------------------------------------- */

async function payloadFor(user, { force = false } = {}) {
  const full = await getExplorerPayload({ force });
  const orgIds = await scopedOrgIds(user);
  return scopePayload(full, { orgIds, role: user.role });
}

/* The controls injected into the explorer. Built here rather than in render.js
 * because what a person may reach is a question about their layer, and that
 * lives with the rest of the access rules. */
async function explorerChrome(user) {
  const orgIds = await scopedOrgIds(user);

  const [drafts, pending] = await Promise.all([
    countReturns({ orgIds, status: STATUS.IN_PROGRESS }),
    canApprove(user) ? countReturns({ orgIds, status: STATUS.SUBMITTED }) : 0,
  ]);

  const links = [
    { href: '/returns', label: 'Returns', count: drafts || null },
  ];
  if (canApprove(user)) {
    links.push({ href: '/approvals', label: 'Approvals', count: pending || null });
  }
  if (user.role === 'super') {
    links.push({ href: '/admin/users', label: 'Users' }, { href: '/admin/audit', label: 'Audit' });
  }
  links.push({ href: '/home', label: 'Summary' }, { href: '/account/password', label: 'Password' });
  if (user.role === 'super') {
    const open = await countOpenQuestions();
    links.push({ href: '/admin/questions', label: 'Questions', count: open || null });
  }

  /* An inspector is looking at a page where most of the abattoirs have no
   * name. Say why, on the page, rather than leaving it to look like a fault. */
  const scopeNote = user.role === 'user'
    ? 'You see your own abattoir named. Every other plant is counted — so the provincial and '
      + 'national comparisons are correct — but is not identified, because condemnation detail is '
      + 'commercially sensitive.'
    : user.role === 'admin'
      ? `You see every abattoir in ${user.scopeProvince} named. Plants in other provinces are `
        + 'counted but not identified.'
      : '';

  return {
    user: { fullName: user.fullName, scopeLabel: scopeLabel(user) },
    links,
    /* Same tab, not a new one. The phone app now carries a way back, and a
     * back link inside a tab that was opened fresh just leaves two explorer
     * tabs behind. One tab, one trail. */
    primary: { href: '/mobile', label: 'Schedule 8 Mobile' },
    /* A separate system entirely, so a new tab rather than the same-tab
     * convention above - leaving this one behind should not cost the trail
     * back through ARMS. */
    secondary: [
      { href: 'http://foodsafetyaudits.co.za/login', label: 'HAS System', external: true },
    ],
    scopeNote,
  };
}

/* The phone app's strip: a way back to the explorer, and nothing else it does
 * not need. It is a focused capture tool and the screen is a phone. */
function mobileChrome(user) {
  return {
    user: { fullName: user.fullName, scopeLabel: scopeLabel(user) },
    back: { href: '/explorer', label: 'Abattoir Explorer' },
    links: [{ href: '/returns', label: 'Capture desk' }],
  };
}

app.get('/explorer', wrap(async (req, res) => {
  const [payload, chrome] = await Promise.all([
    payloadFor(req.user, { force: req.query.refresh === '1' }),
    explorerChrome(req.user),
  ]);
  res.type('html').send(await renderExplorer(config.paths.explorerTemplate, payload, chrome));
}));

app.get('/mobile', wrap(async (req, res) => {
  const def = await getFormDefinition({ force: req.query.refresh === '1' });
  const orgIds = await scopedOrgIds(req.user);
  /* The phone app lists the abattoirs this inspector may file for - which for
   * an inspector is exactly one. */
  const scoped = orgIds === null ? def : {
    ...def,
    abattoirs: def.abattoirs.filter(([id]) => orgIds.includes(Number(id))),
    abattoirRule: `${def.abattoirRule}, limited to ${scopeLabel(req.user).toLowerCase()}`,
  };
  res.type('html').send(await renderMobile(config.paths.mobileApp, scoped, mobileChrome(req.user)));
}));

app.get('/api/data', wrap(async (req, res) => {
  res.json(await payloadFor(req.user, { force: req.query.refresh === '1' }));
}));

app.get('/api/form-definition', wrap(async (req, res) => {
  res.json(await getFormDefinition({ force: req.query.refresh === '1' }));
}));

app.get('/api/abattoirs', wrap(async (req, res) => {
  const def = await getFormDefinition();
  const orgIds = await scopedOrgIds(req.user);
  const list = def.abattoirs.filter(([id]) => orgIds === null || orgIds.includes(Number(id)));
  res.json({
    rule: def.abattoirRule,
    scope: scopeLabel(req.user),
    count: list.length,
    abattoirs: list.map(([orgId, name, species]) => ({
      orgId, name, species: species ? species.split(',') : [],
    })),
  });
}));

app.get('/api/register', wrap(async (req, res) => {
  const full = await getExplorerPayload();
  const orgIds = await scopedOrgIds(req.user);
  const abattoirs = scopeRegister(full, { orgIds });
  res.json({
    count: abattoirs.length,
    reporting: full.meta.reporting,
    identified: abattoirs.filter((a) => a.identified).length,
    provinceDisagreements: full.meta.provClash,
    abattoirs,
  });
}));

/* The write API, for the phone app to post to. Same payload the capture desk
 * builds, same validator, same rules. */
app.post('/api/returns', wrap(async (req, res) => {
  const { saveDraft } = await import('./capture.js');
  const { mayReachOrg } = await import('./auth/users.js');
  const { audit, ACTIONS } = await import('./audit.js');

  const payload = req.body;
  const orgId = Number(payload?.abattoir?.orgId);

  if (!await mayReachOrg(req.user, orgId)) {
    return res.status(403).json({ error: 'That abattoir is outside your scope.' });
  }

  try {
    const result = await saveDraft({
      payload, user: req.user, submit: req.query.submit === '1',
    });
    await audit({
      user: req.user,
      action: req.query.submit === '1' ? ACTIONS.RETURN_SUBMITTED : ACTIONS.RETURN_SAVED,
      entityType: 'return', entityId: result.frmdId,
      detail: { orgId, period: payload?.period?.month, source: payload?.source },
      ip: clientIp(req),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, validation: err.validation || null });
  }
}));

/* Asked from the explorer's "Ask it something" tab, when the canned list does
 * not cover it. Stored against the account; a super user answers it at
 * /admin/questions. */
app.post('/api/questions', wrap(async (req, res) => {
  try {
    const question = await askQuestion({ user: req.user, text: req.body?.text });
    await audit({
      user: req.user, action: ACTIONS.QUESTION_ASKED, entityType: 'question',
      entityId: question.questionId, ip: clientIp(req),
    });
    res.json({ ok: true, question });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

app.get('/api/questions/mine', wrap(async (req, res) => {
  res.json({ questions: await myQuestions(req.user.userId) });
}));

app.post('/api/refresh', wrap(async (req, res) => {
  clearCache();
  clearFormCache();
  await loadFormIndex({ force: true });
  res.json({ ok: true, message: 'Caches cleared. The next request rebuilds from SQL.' });
}));

app.get('/download/explorer', (req, res, next) => {
  /* The built offline file carries every abattoir's detail. Only somebody who
   * may already see all of it may take a copy away. */
  if (req.user.role === 'user') {
    return res.status(403).send('The offline copy holds every abattoir\'s figures, so it is not available at your access level.');
  }
  /* The built 2,4 MB explorer is a handover artefact, not something this
   * repository carries or this server produces. It is the file as it stood,
   * with eleven years of figures compiled into it, and rendering a fresh copy
   * to stand in its place would be a different document wearing its name - the
   * offline artefact is supposed to be the frozen one.
   *
   * So when it has not been deployed, say that. Passing the absence to the
   * error handler raised a 500, which reads as a broken server rather than a
   * file nobody copied up, and check.js already promises this route "will say
   * so". The explorer itself is unaffected - it is built from the template on
   * every request and never needed this file. */
  if (!fs.existsSync(config.paths.explorerBuilt)) {
    return res.status(404).type('text/plain').send(
      'The offline copy of the Abattoir Explorer is not on this server.\n\n'
      + 'It is a handover artefact rather than part of the application, so it is put in\n'
      + 'place separately: copy it across and point EXPLORER_BUILT in .env at it.\n\n'
      + 'Nothing else is affected. The explorer is live at /explorer, built from the\n'
      + 'database on every request, and the phone app still downloads from /download/mobile.'
    );
  }
  res.download(config.paths.explorerBuilt, 'Abattoir Explorer.html');
});

app.get('/download/mobile', (req, res, next) => {
  if (!fs.existsSync(config.paths.mobileApp)) return next(new Error(`Not on this machine: ${config.paths.mobileApp}`));
  res.download(config.paths.mobileApp, 'Schedule 8 Mobile.html');
});

/* ---------------------------------------------------------------------------
 * Home
 * ------------------------------------------------------------------------- */

/* THE LANDING PAGE IS THE EXPLORER.
 *
 * It is what people sign in for. The account controls are injected onto it
 * (see explorerChrome above), so there is no separate home page to pass
 * through - the summary below stays reachable at /home for the drafts-and-
 * approvals view, but nobody has to visit it to get to work. */
app.get('/', (req, res) => res.redirect('/explorer'));

app.get('/home', wrap(async (req, res) => {
  const orgIds = await scopedOrgIds(req.user);
  const [drafts, pending] = await Promise.all([
    listReturns({ orgIds, status: STATUS.IN_PROGRESS, limit: 10 }),
    canApprove(req.user) ? listReturns({ orgIds, status: STATUS.SUBMITTED, limit: 10 }) : [],
  ]);

  const card = (href, title, sub) =>
    `<a class="card" href="${href}"><b>${esc(title)}</b><span>${esc(sub)}</span></a>`;

  res.type('html').send(page({
    title: 'Summary', user: req.user, active: '/home',
    body: `
<h1>${esc(req.user.fullName.split(' ')[0])}</h1>
<p class="sub">${esc(scopeLabel(req.user))}</p>

${messages({ ok: req.query.changed ? 'Password changed.' : null })}

${pending.length ? `<div class="msg warn"><b>${pending.length} return${pending.length === 1 ? '' : 's'} waiting for your approval.</b>
  Nothing they contain is counted until you approve it. <a href="/approvals">Go to approvals</a></div>` : ''}

${drafts.length ? `<div class="msg"><b>${drafts.length} draft${drafts.length === 1 ? '' : 's'} not yet submitted.</b>
  <ul>${drafts.map((d) => `<li><a href="/returns/${d.frmdId}">${esc(d.orgName)} — ${esc(d.period)}</a> ${statusPill(d.status)}</li>`).join('')}</ul></div>` : ''}

<h2>Capture</h2>
${card('/returns/new', 'Start a return', 'The monthly Schedule 8, with the same validation as the phone app.')}
${card('/returns', 'Returns', 'Everything in your scope, and how far each one has got.')}
${canApprove(req.user) ? card('/approvals', 'Approvals', 'Approve submitted returns, and chase the abattoirs that have not filed.') : ''}

<h2>Look at the figures</h2>
${card('/explorer', 'Abattoir Explorer', 'Eleven years of returns, read from SQL when you open it. This is where you land after signing in.')}
${card('/mobile', 'Schedule 8 Mobile', 'The phone capture form, for the abattoirs you cover.')}

${req.user.role === 'super' ? `<h2>Administration</h2>
${card('/admin/users', 'Who has access', 'Create accounts, set the layer and the scope, disable and reset.')}
${card('/admin/audit', 'Who did what', 'Every approval, submission, correction and account change.')}` : ''}

${req.user.role === 'user' ? `<div class="note">You see your own plant's figures named, and every other
abattoir counted but not identified — so a provincial or national comparison is correct while nobody
else's detail is exposed. That is deliberate: a plant may see where it stands against the average,
never who is worse.</div>` : ''}

<h2>Your account</h2>
${card('/account/password', 'Change your password', 'Signs you out on every other device.')}
${card('/logout', 'Sign out', '')}`,
  }));
}));

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).type('html').send(page({
    title: 'Not found', user: req.user,
    body: `<h1>Not found</h1><p class="sub">No route for <code>${esc(req.path)}</code>.</p>
    <p><a href="/">Back to the start</a></p>`,
  }));
});

app.use((err, req, res, next) => {
  console.error(`  ${req.method} ${req.path} failed:`, err.message);
  res.status(500).type('html').send(page({
    title: 'Error', user: req.user,
    body: `
<h1>That did not work</h1>
<p class="sub">The page could not be built.</p>
<div class="msg bad">${esc(err.message)}</div>
<h2>Usually one of</h2>
<ul class="tiny">
  <li>SQL Server is not reachable, or the login in <code>.env</code> is wrong — try <a href="/api/health">/api/health</a>.</li>
  <li><code>DB_DATA</code>, <code>DB_REGISTRY</code> or <code>DB_FORMS</code> names a database that is not restored.</li>
  <li>The ARMS tables are missing — run <code>npm run init-db</code>.</li>
</ul>
<p><a href="/">Back to the start</a></p>`,
  }));
});

/* ---------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */

function start() {
  try {
    validateConfig();
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  const server = app.listen(config.http.port, config.http.host, async () => {
    /* Tunables come from arms.Setting, overlaying .env. Done here rather than at
     * import time because it needs the database, and the server should still
     * come up and say why if the database is unreachable. */
    const applied = await loadSettings({ log: (m) => console.log(m) });

    const b = baseUrl();
    console.log('');
    console.log('  ARMS backend');
    console.log(`  reading ${config.databases.data}, ${config.databases.registry}, ${config.databases.forms} on ${config.sql.server}`);
    console.log(`  ARMS starts at ${config.arms.fromYear}`);
    if (applied.length) {
      console.log(`  settings from the database: ${applied.join(' · ')}`);
    }

    try {
      const n = await countUsers();
      console.log(n === 0
        ? '  NO ACCOUNTS YET — run: npm run init-db'
        : `  ${n} account${n === 1 ? '' : 's'}`);
    } catch {
      console.log('  ARMS tables not found — run: npm run init-db');
    }

    console.log('');
    console.log(`    sign in          ${b}/login`);
    console.log(`    Abattoir Explorer  ${b}/explorer`);
    console.log(`    capture a return ${b}/returns`);
    console.log(`    approvals        ${b}/approvals`);
    console.log(`    health           ${b}/api/health`);
    console.log('');

    if (!config.http.secureCookies && config.http.host !== '127.0.0.1' && config.http.host !== 'localhost') {
      console.log('  WARNING: listening beyond this machine without Secure cookies.');
      console.log('  Put it behind TLS and set SECURE_COOKIES=true before anyone real uses it.\n');
    }
  });

  /* Dead sessions accumulate; clear them daily. unref so it never holds the
   * process open on shutdown. */
  const sweeper = setInterval(() => {
    purgeExpiredSessions().catch(() => {});
  }, 24 * 3600 * 1000);
  sweeper.unref();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${config.http.port} is already in use. Set PORT in .env to something else.\n`);
      process.exit(1);
    }
    throw err;
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n  shutting down');
      server.close(() => closePool().finally(() => process.exit(0)));
    });
  }
}

start();
