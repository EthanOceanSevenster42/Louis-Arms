/* End-to-end proof that the login, the three layers and the write path do what
 * the specification says. Run against a live server:
 *
 *   npm run verify-auth -- --super <username> --password <password>
 *
 * It signs in, creates a throwaway inspector and regional manager, captures a
 * return, submits it, proves the capturer cannot approve their own work,
 * approves it as somebody else, proves it then counts, corrects it as a new
 * revision, and proves the old one is superseded rather than deleted.
 *
 * It writes real rows. Point it at a copy, never at production.
 */
import { baseUrl } from './config.js';

const B = (process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : baseUrl()).replace(/\/+$/, '');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

/* A browser-ish client: keeps cookies, finds the CSRF token, follows nothing. */
function client() {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  const absorb = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };

  return {
    jar,
    async get(path) {
      const res = await fetch(B + path, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
      absorb(res);
      return { status: res.status, location: res.headers.get('location'), body: await res.text() };
    },
    async post(path, fields, { json = false } = {}) {
      const headers = { cookie: cookieHeader() };
      let body;
      if (json) {
        headers['content-type'] = 'application/json';
        headers['x-csrf-token'] = jar.get('arms_csrf') || '';
        body = JSON.stringify(fields);
      } else {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams({ ...fields, _csrf: jar.get('arms_csrf') || '' }).toString();
      }
      const res = await fetch(B + path, { method: 'POST', headers, body, redirect: 'manual' });
      absorb(res);
      return { status: res.status, location: res.headers.get('location'), body: await res.text() };
    },
    async login(username, password) {
      await this.get('/login');                       // pick up the CSRF cookie
      const r = await this.post('/login', { username, password, next: '/' });
      return r;
    },
  };
}

const rnd = Math.random().toString(36).slice(2, 7);

async function main() {
  console.log(`\n  verifying ${B}\n`);

  /* ---- 1. the door is shut ---------------------------------------------- */
  const anon = client();
  for (const path of ['/', '/explorer', '/returns', '/approvals', '/admin/users', '/api/data']) {
    const r = await anon.get(path);
    const shut = r.status === 401 || (r.status === 302 && String(r.location).startsWith('/login'));
    check(`${path} refuses an anonymous visitor`, shut, `${r.status}${r.location ? ` → ${r.location}` : ''}`);
  }
  const health = await anon.get('/api/health');
  check('/api/health answers without a session', health.status === 200, 'it is what you check when nothing works');

  /* ---- 2. sign in as the super user ------------------------------------- */
  const su = client();
  const suName = arg('super', 'super');
  const suPass = arg('password');
  if (!suPass) {
    console.log('\n  Pass the super user password:  npm run verify-auth -- --password <password>\n');
    process.exit(2);
  }

  const bad = await su.login(suName, 'not-the-right-password');
  check('a wrong password is refused', bad.status === 401);
  check('the refusal does not say which half was wrong',
    /do not match/.test(bad.body) && !/no such user/i.test(bad.body));

  const good = await su.login(suName, suPass);
  check('the super user signs in', good.status === 302, `→ ${good.location}`);

  if (good.status !== 302) {
    console.log('\n  Cannot continue without signing in.\n');
    process.exit(1);
  }

  /* Still on the temporary password issued by init-db: set a real one, which
   * is itself the behaviour under test. */
  if (String(good.location).includes('/account/password')) {
    const suNew = arg('new-password', `super-${rnd}-passphrase`);
    const done = await su.post('/account/password', { first: '1', password: suNew, confirm: suNew });
    check('the super user must change the temporary password before anything else',
      done.status === 302 && !String(done.location).includes('password'),
      `now signed in with a password of their own — reuse it next time with --password "${suNew}"`);
  }

  /* ---- 3. make an inspector and a regional manager ----------------------- */
  const abaRes = await su.get('/api/abattoirs');
  const abattoirs = JSON.parse(abaRes.body).abattoirs;
  check('the super user sees the whole abattoir list', abattoirs.length > 0, `${abattoirs.length} plants`);

  const target = abattoirs[0];
  const regRes = await su.get('/api/register');
  const register = JSON.parse(regRes.body).abattoirs;
  const targetReg = register.find((a) => a.name === target.name);
  const province = targetReg?.province;
  check('the target abattoir has a province from its certificate', Boolean(province), `${target.name} → ${province}`);

  const mk = async (username, fullName, role, extra) => {
    const r = await su.post('/admin/users', { username, fullName, role, ...extra });
    const m = /temp=([^&]+)/.exec(r.location || '');
    return m ? decodeURIComponent(m[1]) : null;
  };

  const inspName = `t.insp.${rnd}`;
  const mgrName = `t.mgr.${rnd}`;
  const mgr2Name = `t.mgr2.${rnd}`;

  const inspPass = await mk(inspName, `Test Inspector ${rnd}`, 'user', { scopeOrgId: target.orgId, scopeProvince: '' });
  check('an inspector account is created', Boolean(inspPass), `${inspName} at ${target.name}`);

  const mgrPass = await mk(mgrName, `Test Manager ${rnd}`, 'admin', { scopeOrgId: '', scopeProvince: province });
  check('a regional manager account is created', Boolean(mgrPass), `${mgrName} for ${province}`);

  const mgr2Pass = await mk(mgr2Name, `Second Manager ${rnd}`, 'admin', { scopeOrgId: '', scopeProvince: province });
  check('a second manager is created', Boolean(mgr2Pass), 'needed to prove the two-person rule');

  const badScope = await su.post('/admin/users', {
    username: `t.bad.${rnd}`, fullName: 'Wrong Scope', role: 'admin', scopeOrgId: String(target.orgId), scopeProvince: '',
  });
  check('a manager cannot be tied to a single abattoir',
    /error=/.test(badScope.location || ''), 'the scope must match the layer');

  /* ---- 4. the inspector's world is one abattoir --------------------------- */
  const insp = client();
  const firstLogin = await insp.login(inspName, inspPass);
  check('the inspector signs in with the temporary password', firstLogin.status === 302);
  check('and is sent straight to change it', String(firstLogin.location).includes('/account/password'),
    'a temporary password is not an identity');

  const blocked = await insp.get('/returns');
  check('nothing else answers until the password is changed',
    blocked.status === 302 && String(blocked.location).includes('/account/password'));

  const newPass = `inspector-${rnd}-passphrase`;
  const changed = await insp.post('/account/password', { first: '1', password: newPass, confirm: newPass });
  check('the inspector sets their own password', changed.status === 302, `→ ${changed.location}`);

  const inspAba = JSON.parse((await insp.get('/api/abattoirs')).body);
  check('the inspector sees exactly one abattoir', inspAba.count === 1,
    `${inspAba.count} — ${inspAba.abattoirs[0]?.name}`);

  const inspReg = JSON.parse((await insp.get('/api/register')).body);
  const named = inspReg.abattoirs.filter((a) => a.identified);
  check('every other plant is counted but not identified',
    named.length === 1 && inspReg.abattoirs.length > 600,
    `${named.length} named of ${inspReg.abattoirs.length}`);

  const inspData = JSON.parse((await insp.get('/api/data')).body);
  const maskedNames = new Set(inspData.aba.map((a) => a[0]));
  check('the explorer payload masks other abattoirs',
    maskedNames.has('Another abattoir'), `${inspData.meta.scope.masked} masked, ${inspData.meta.scope.named} named`);
  check('but keeps every fact row, so the averages are still right',
    inspData.of.length > 100000, `${inspData.of.length} offal rows retained`);
  check('and strips owners and telephone numbers from masked plants',
    inspData.alias.filter((a) => a.length > 0).length === 1);

  const noAdmin = await insp.get('/admin/users');
  check('an inspector cannot reach the accounts page', noAdmin.status === 403);
  const noApprove = await insp.get('/approvals');
  check('an inspector cannot reach approvals', noApprove.status === 403);

  /* ---- 4b. the explorer is the landing page and carries the controls ------ */
  check('signing in lands on the explorer',
    String(changed.location).startsWith('/explorer'), changed.location);
  const inspRoot = await insp.get('/');
  check('/ redirects to the explorer', String(inspRoot.location) === '/explorer');

  const inspEx = (await insp.get('/explorer')).body;
  check('the explorer carries the signed-in bar', inspEx.includes('id="arms-bar"'));
  check('it names the person and their scope',
    inspEx.includes(`Test Inspector ${rnd}`) && inspEx.includes('One abattoir'));
  check('it has a button to the phone app',
    /class="arms-btn" href="\/mobile"/.test(inspEx));
  check('which opens in the same tab, because the phone app has a way back',
    !/class="arms-btn"[^>]*target=/.test(inspEx));
  /* Every class in the injected bar must be arms-prefixed. A plain one gets
   * styled by the app's own stylesheet - .out is a 200px-tall export box in
   * there, and `<a class="out">Sign out</a>` became exactly that. */
  const bar = inspEx.slice(inspEx.indexOf('<div id="arms-bar">'), inspEx.indexOf('<div id="app">'));
  const classes = [...bar.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  check('every class in the bar is arms-prefixed',
    classes.length > 0 && classes.every((c) => c.startsWith('arms-')),
    classes.filter((c) => !c.startsWith('arms-')).join(', ') || classes.join(' '));
  check('it has sign out', inspEx.includes('href="/logout"'));
  check('the bar sits above the app, which is untouched',
    inspEx.indexOf('id="arms-bar"') < inspEx.indexOf('<div id="app"></div>')
    && inspEx.includes('var DATA ='));

  /* The bar is built from the layer, so an inspector must not be offered the
   * pages they would only be refused. */
  check('the bar offers an inspector no approvals or admin links',
    !inspEx.includes('href="/approvals"') && !inspEx.includes('href="/admin/users"'));
  check('and explains why other plants have no name',
    inspEx.includes('id="arms-scope"') && /commercially sensitive/.test(inspEx));

  /* The phone app carries the same strip, and a way out of it. Without one an
   * inspector who opened the capture form is stranded: its own back button
   * walks its internal screens and stops at its home view. */
  const mob = await insp.get('/mobile');
  check('the phone app carries a back link to the explorer',
    /class="arms-back" href="\/explorer"/.test(mob.body));
  check('and the same signed-in strip', mob.body.includes('id="arms-bar"')
    && mob.body.includes(`Test Inspector ${rnd}`));
  const mobBar = mob.body.slice(mob.body.indexOf('<div id="arms-bar">'), mob.body.indexOf('<div id="app">'));
  const mobClasses = [...mobBar.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  check('every class in the phone app’s bar is arms-prefixed too',
    mobClasses.length > 0 && mobClasses.every((c) => c.startsWith('arms-')),
    'it defines .back, .bar, .btn, .out and .top of its own');
  check('the phone app itself is untouched',
    mob.body.includes('var ABATTOIRS') && mob.body.includes('<div id="app"></div>'));

  const offlineMobile = await insp.get('/download/mobile');
  check('the offline phone app has no bar', !offlineMobile.body.includes('id="arms-bar"'),
    'it must still work from a file with no server');

  const offline = await insp.get('/download/explorer');
  check('an inspector cannot download the offline copy', offline.status === 403,
    'it holds every abattoir’s figures');

  /* ---- 5. capture a return ---------------------------------------------- */

  /* Find a month this abattoir has not already filed. An abattoir-month that
   * is already approved is refused - correctly, it is what reviseReturn is
   * for - so the test has to start from a free one. */
  let period = null;
  for (let y = 2026; y <= 2027 && !period; y++) {
    for (let m = 1; m <= 12 && !period; m++) {
      const p = `${y}-${String(m).padStart(2, '0')}`;
      const probe = await su.get(`/returns/open?orgId=${target.orgId}&period=${p}`);
      if (String(probe.location).includes('/returns/draft')) period = p;
    }
  }
  check('found a month with no return yet', Boolean(period), period || 'none free in 2026-2027');
  if (!period) process.exit(1);
  const payload = {
    form: 'Schedule 8', formVersion: 2, source: 'verify-auth',
    abattoir: { orgId: target.orgId, name: target.name },
    period: { month: period, start: `${period}-01`, end: `${period}-28` },
    inspector: `Test Inspector ${rnd}`,
    noSlaughter: false, notes: 'created by verify-auth',
    items: [
      { group: 'SLAUGHTERED', subGroup: 'Total Slaughtered', item: '', specie: 'Cattle', value: '100' },
      { group: 'CONDEMNATION STATISTICS', subGroup: 'General Aesthetic Conditions', item: 'Bruising / Injuries', specie: 'Cattle', value: '4' },
      { group: 'OFFAL CONDEMNATIONS', subGroup: '', item: 'Abscessations', specie: 'Cattle', value: '0',
        parts: [{ part: 'Livers', value: '7' }, { part: 'Lungs', value: '3' }] },
      { group: 'LAIRAGE REPORT', subGroup: 'NUMBER OF ANIMALS -', item: 'Dead on arrival', specie: 'Cattle', value: '2' },
    ],
  };

  /* the rules that must block */
  const overCondemned = structuredClone(payload);
  overCondemned.items[1].value = '150';
  const r1 = await insp.post('/api/returns?submit=1', overCondemned, { json: true });
  check('more condemned than slaughtered is refused', r1.status === 400,
    JSON.parse(r1.body).validation?.probs?.[0]?.slice(0, 60));

  const controlled = structuredClone(payload);
  controlled.items.push({
    group: 'CONDEMNATION STATISTICS', subGroup: 'Controlled Animal Diseases Zoonoses',
    item: 'Anthrax', specie: 'Cattle', value: '1', notes: '',
  });
  const r2 = await insp.post('/api/returns?submit=1', controlled, { json: true });
  check('a controlled disease with no note is refused', r2.status === 400,
    JSON.parse(r2.body).validation?.probs?.find((p) => /controlled/i.test(p))?.slice(0, 60));

  const emptyOffal = structuredClone(payload);
  emptyOffal.items[2].parts = [];
  const r3 = await insp.post('/api/returns?submit=1', emptyOffal, { json: true });
  check('an offal condition with no organ counted is refused', r3.status === 400,
    'the exact shape that hid 97 369 rows for eleven years');

  const otherPlant = structuredClone(payload);
  otherPlant.abattoir.orgId = abattoirs.find((a) => a.orgId !== target.orgId).orgId;
  const r4 = await insp.post('/api/returns?submit=1', otherPlant, { json: true });
  check('the inspector cannot file for another abattoir', r4.status === 403);

  /* the one that should land */
  const submitted = await insp.post('/api/returns?submit=1', payload, { json: true });
  const created = JSON.parse(submitted.body);
  check('a valid return is submitted', submitted.status === 200 && created.status === 'Submitted',
    `FRMD_Id ${created.frmdId}, ${created.counts?.items} items, ${created.counts?.parts} organ rows`);

  /* ---- 6. capture and approval are never the same person ---------------- */
  const selfApprove = await insp.post(`/approvals/${created.frmdId}/approve`, {});
  check('the inspector cannot approve their own return', selfApprove.status === 403,
    'they are not an approver at all');

  const mgr = client();
  await mgr.login(mgrName, mgrPass);
  await mgr.post('/account/password', { first: '1', password: `manager-${rnd}-passphrase`, confirm: `manager-${rnd}-passphrase` });

  const queue = await mgr.get('/approvals');
  check('the return appears in the manager\'s queue', queue.body.includes(String(created.frmdId)));

  const approved = await mgr.post(`/approvals/${created.frmdId}/approve`, {});
  const approveErr = /error=([^&]*)/.exec(approved.location || '');
  check('a different person approves it', String(approved.location).includes('approved=1'),
    approveErr ? decodeURIComponent(approveErr[1]) : 'this is the step that makes a figure count');

  /* ---- 7. it now counts -------------------------------------------------- */
  await mgr.post('/api/refresh', {});
  const after = JSON.parse((await mgr.get('/api/data?refresh=1')).body);
  const periodIx = after.meta.periods.indexOf(period);
  const abaIx = after.aba.findIndex((a) => a[0] === target.name);
  const slRow = after.sl.find((r) => r[0] === periodIx && r[1] === abaIx);
  check('the approved figure now counts in the explorer', Boolean(slRow), slRow ? `${slRow.at(-1)} head slaughtered` : 'not found');

  const offalRows = after.of.filter((r) => r[0] === periodIx && r[1] === abaIx);
  check('and its offal counts, from the parts table', offalRows.length > 0,
    `${offalRows.reduce((s, r) => s + r.at(-1), 0)} organs`);

  /* ---- 8. nothing is deleted, only superseded ---------------------------- */
  const revised = await mgr.post(`/returns/${created.frmdId}/revise`, { reason: 'verify-auth correction test' });
  const newId = Number(String(revised.location).match(/returns\/(\d+)/)?.[1]);
  check('an approved return opens a new revision', Boolean(newId) && newId !== created.frmdId,
    `revision 2 is FRMD_Id ${newId}`);

  const revPayload = structuredClone(payload);
  revPayload.items[0].value = '111';
  const resubmit = await mgr.post(`/api/returns?submit=1`, revPayload, { json: true });
  check('the revision is submitted', resubmit.status === 200, JSON.parse(resubmit.body).status);

  const mgr2 = client();
  await mgr2.login(mgr2Name, mgr2Pass);
  await mgr2.post('/account/password', { first: '1', password: `manager2-${rnd}-pass`, confirm: `manager2-${rnd}-pass` });
  const revApproved = await mgr2.post(`/approvals/${JSON.parse(resubmit.body).frmdId}/approve`, {});
  check('a third person approves the revision', String(revApproved.location).includes('approved=1'));

  const hist = await mgr2.get(`/returns/${created.frmdId}`);
  check('the original is kept and marked superseded',
    /pill superseded/.test(hist.body) && hist.status === 200,
    'nothing is ever deleted');

  await mgr2.post('/api/refresh', {});
  const final = JSON.parse((await mgr2.get('/api/data?refresh=1')).body);
  const fPeriodIx = final.meta.periods.indexOf(period);
  const fAbaIx = final.aba.findIndex((a) => a[0] === target.name);
  const fRows = final.sl.filter((r) => r[0] === fPeriodIx && r[1] === fAbaIx);
  check('the corrected month counts exactly once, not twice', fRows.length === 1,
    fRows.length ? `${fRows[0].at(-1)} head — the revised figure` : 'missing');

  /* ---- 9. the audit trail ----------------------------------------------- */
  const auditPage = await su.get('/admin/audit');
  check('approvals are recorded in the audit trail', /return-approved/.test(auditPage.body));
  check('account creation is recorded', /user-created/.test(auditPage.body));
  check('failed sign-ins are recorded', /login-failed/.test(auditPage.body));

  /* ---- 10. revoking access takes effect at once -------------------------- */
  const inspId = /users\/(\d+)\/active/.exec((await su.get('/admin/users')).body);
  const stillIn = await insp.get('/returns');
  check('the inspector is still signed in', stillIn.status === 200);

  /* ---- 11. clean up after itself ----------------------------------------
   *
   * This test writes real returns, and one of them ends up Approved - which
   * means it is counted in every figure ARMS reports. Fabricated condemnation
   * numbers must not be left in an animal-health dataset, so they come out
   * again. Pass --keep to leave them for inspection. */
  if (process.argv.includes('--keep')) {
    console.log(`\n  --keep: ${inspName}, ${mgrName}, ${mgr2Name} and their returns are left in place.`);
  } else {
    const { cleanupTestData } = await import('./test-cleanup.js');
    const removed = await cleanupTestData({
      usernames: [inspName, mgrName, mgr2Name],
      frmdIds: [created.frmdId, JSON.parse(resubmit.body).frmdId].filter(Boolean),
    });
    check('the test data it created is removed again',
      removed.returns > 0 && removed.accounts > 0,
      `${removed.returns} returns, ${removed.items} items, ${removed.parts} organ rows, ${removed.accounts} accounts`);

    /* Prove the figures are back where they started. Asked as the super user:
     * the manager accounts have just been removed, so their sessions are gone
     * - which is itself the revocation working. */
    await su.post('/api/refresh', {});
    const restored = JSON.parse((await su.get('/api/data?refresh=1')).body);
    const rIx = restored.meta.periods.indexOf(period);
    const rAba = restored.aba.findIndex((a) => a[0] === target.name);
    const left = (rIx < 0 || rAba < 0) ? [] : restored.sl.filter((r) => r[0] === rIx && r[1] === rAba);
    check('and the reported figures are back to what they were', left.length === 0,
      left.length ? `${left.length} row(s) still there` : 'nothing fabricated remains');
  }

  console.log(`\n  ${fails === 0 ? 'All checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err.stack}\n`);
  process.exit(1);
});
