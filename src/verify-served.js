/* Fetch both applications exactly as a browser would and prove the injected
 * values are real: the explorer's DATA parses and is live, and the phone app's
 * generated block is valid, strict-mode ES5 that defines every list.
 *
 * Both now sit behind the login, so this signs in first. It uses a super user
 * because the point of this check is that the FULL payload renders - the
 * scoped view is what verify-auth tests.
 *
 *   npm run verify -- --password <password>
 *   npm run verify -- --url https://arms.afsq.co.za --super louis --password ...
 */
import vm from 'node:vm';
import { baseUrl } from './config.js';

const argOf = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const B = (argOf('url') || baseUrl()).replace(/\/+$/, '');
const USER = argOf('super', 'super');
const PASS = argOf('password');

if (!PASS) {
  console.log('\n  Needs a super user to sign in with:\n    npm run verify -- --password <password>\n');
  process.exit(2);
}

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

const jar = new Map();
const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function req(path, init = {}) {
  const res = await fetch(B + path, {
    ...init,
    headers: { cookie: cookies(), ...(init.headers || {}) },
    redirect: 'manual',
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

console.log(`\n  verifying ${B}\n`);

await req('/login');                                   // collect the CSRF cookie
const signIn = await req('/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    username: USER, password: PASS, next: '/', _csrf: jar.get('arms_csrf') || '',
  }).toString(),
});

if (signIn.status !== 302) {
  console.log('  FAIL  could not sign in — check the username and password.\n');
  process.exit(1);
}
if (String(signIn.headers.get('location')).includes('/account/password')) {
  console.log('  FAIL  that account is still on its temporary password.');
  console.log('        Sign in once in a browser and set a real one first.\n');
  process.exit(1);
}
check(`signed in as ${USER}`, true);

/* ---- the explorer ------------------------------------------------------- */
const ex = await (await req('/explorer')).text();
const m = ex.match(/\/\*__DATA__\*\/([\s\S]*?)\/\*__END__\*\//);
check('explorer carries a DATA block', Boolean(m));

const DATA = JSON.parse(m[1].replace(/<\\\//g, '</'));
check('DATA parses as JSON', true, `${Object.keys(DATA).length} top-level keys`);
check('DATA is live, not the frozen build', DATA.meta.source?.live === true,
  `source: ${DATA.meta.source?.databases?.data} on ${DATA.meta.source?.server}`);
check('a super user sees every abattoir named', DATA.meta.scope?.masked === 0,
  DATA.meta.scope?.sees);
check('periods present', DATA.meta.periods.length > 0,
  `${DATA.meta.periods[0]} to ${DATA.meta.periods.at(-1)}`);
check('register carried', DATA.aba.length >= 600, `${DATA.aba.length} certificates`);
check('offal facts present', DATA.of.length > 100000, `${DATA.of.length} rows`);
check('no </script> can close the block early', !m[1].includes('</script'));

/* The four measures, still apart. */
const tot = (r) => r.reduce((s, x) => s + x[x.length - 1], 0);
console.log(`        head ${tot(DATA.wc).toLocaleString()} · kg ${Math.round(tot(DATA.pc)).toLocaleString()} · organs ${tot(DATA.of).toLocaleString()} · lairage ${tot(DATA.lr).toLocaleString()}`);

/* ---- the phone app ------------------------------------------------------ */
const mob = await (await req('/mobile')).text();
const start = mob.indexOf('/* ---------- form definition');
const end = mob.indexOf('/* ---------- storage');
check('phone app carries the generated block', start > -1 && end > start);
const block = mob.slice(start, end);

/* Run it under 'use strict' - the app is strict ES5, and anything the
 * generator emitted that an old phone could not parse throws here. */
const ctx = vm.createContext({});
let ran = true;
let err = '';
try { vm.runInContext(`'use strict';\n${block}\n`, ctx); }
catch (e) { ran = false; err = e.message; }
check('generated block parses and runs as strict ES5', ran, err);

if (ran) {
  const g = (n) => vm.runInContext(n, ctx);
  check('SPECIES', g('SPECIES').length === 13, g('SPECIES').join(', '));
  check('ORGANS', g('ORGANS').length === 11, g('ORGANS').join(', '));
  check('WC groups', g('WC').length === 6, g('WC').map((x) => `${x.db}(${x.items.length})`).join(' '));
  check('WC notify flag survives', g('WC').some((x) => x.notify === true));
  check('PC in kilograms', g('PC').length === 29, `${g('PC').length} conditions`);
  check('OFFAL', g('OFFAL').length === 62, `${g('OFFAL').length} conditions`);
  check('LAIR', g('LAIR').length === 5, g('LAIR').join(', '));
  const ab = g('ABATTOIRS');
  check('ABATTOIRS', ab.length > 0, `${ab.length} plants, e.g. ${JSON.stringify(ab[0])}`);
  check('every abattoir is [id, name, species]',
    ab.every((a) => a.length === 3 && typeof a[0] === 'number' && typeof a[1] === 'string'));
  check('the frozen 118-plant list is gone', !/\[5,"Aliwal Abattoir","Cattle,Pigs,Sheep"\]/.test(mob));
}

/* ---- the JSON endpoints -------------------------------------------------- */
for (const [path, test, label] of [
  ['/api/form-definition', (j) => j.species.length === 13 && j.source.live === true, (j) => `${j.species.length} species, live`],
  ['/api/abattoirs', (j) => j.count > 0 && Array.isArray(j.abattoirs), (j) => `${j.count} entries`],
  ['/api/register', (j) => j.count >= 600 && j.identified === j.count, (j) => `${j.count} registered, all identified`],
]) {
  const j = await (await req(path)).json();
  check(path, test(j), label(j));
}

console.log(fails === 0
  ? '\n  Both pages are served live, scoped, and work.\n'
  : `\n  ${fails} failure(s).\n`);
process.exit(fails === 0 ? 0 : 1);
