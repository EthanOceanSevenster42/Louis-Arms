/* Every setting the backend uses, resolved in one place from the environment.
 *
 * NOTHING IN THIS PROJECT HARDCODES A SERVER, A DATABASE NAME, A PORT OR A PATH.
 * The reason is not tidiness. The handover documents say the databases live on
 * `.\SQLEXPRESS`; on the machine this backend was written on they are on the
 * default instance, under different names again, and the FSA cloud server is a
 * third arrangement nobody has specified yet (question 1 of the handover). A
 * value written into a source file would have been wrong three times already.
 *
 * Read the settings from .env. Anything genuinely required is checked at boot
 * and reported by name, so a misconfiguration fails immediately and legibly
 * rather than surfacing later as an empty report.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');

dotenv.config({ path: path.join(backendRoot, '.env') });

const missing = [];

function req(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    missing.push(name);
    return '';
  }
  return String(v).trim();
}

function opt(name, fallback) {
  const v = process.env[name];
  return v === undefined || String(v).trim() === '' ? fallback : String(v).trim();
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') return fallback;
  const n = Number.parseInt(String(v).trim(), 10);
  if (Number.isNaN(n)) {
    missing.push(`${name} (expected a whole number, got "${v}")`);
    return fallback;
  }
  return n;
}

/* Where the two applications live.
 *
 * Three places are tried, in order, and the first that exists wins:
 *   1. the setting in .env, if given - always the last word
 *   2. ./app, which is what ships in the repository and what a deployed
 *      server has
 *   3. the sibling handover folders, so a working copy sitting inside
 *      "Handover to technician" runs with no path settings at all
 *
 * The built `NAHDIS Explorer.html` is deliberately NOT in the repository - it
 * has eleven years of figures and 529 telephone numbers compiled into it. Its
 * absence costs only the offline download; the served explorer is built from
 * the template and the database. */
function resolvePath(name, candidates) {
  const v = process.env[name];
  if (v !== undefined && String(v).trim() !== '') return path.resolve(String(v).trim());

  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const rel of list) {
    const p = path.resolve(backendRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(backendRoot, list[list.length - 1]);
}

export const config = {
  backendRoot,

  http: {
    port: int('PORT', 3000),
    /* 127.0.0.1 by default. This data is commercially sensitive - one abattoir
     * may never see another's condemnation detail - so it does not bind to
     * every interface until somebody decides that deliberately. */
    host: opt('HOST', '127.0.0.1'),
    publicUrl: opt('PUBLIC_URL', ''),
    /* Set behind a reverse proxy so X-Forwarded-For is believed. Off by
     * default: unproxied, that header is written by the caller, and believing
     * it would let anybody put any address into the audit trail. */
    trustProxy: bool('TRUST_PROXY', false),
    /* Cookies marked Secure are not sent over plain HTTP, which would lock
     * everybody out of a local install. On by default whenever PUBLIC_URL is
     * https, off otherwise, and overridable either way. */
    secureCookies: bool('SECURE_COOKIES', opt('PUBLIC_URL', '').startsWith('https://')),
    sessionHours: int('SESSION_HOURS', 8),
  },

  /* MySQL. There is no named-instance or integrated-security case here: a
   * MySQL server is a host and a port, and the login is always a MySQL user. */
  sql: {
    server: req('SQL_SERVER'),
    port: int('SQL_PORT', 3306),
    user: req('SQL_USER'),
    password: req('SQL_PASSWORD'),
    /* TLS to the database. On by default; a MySQL that is not on this machine
     * is carrying condemnation detail across a network. */
    encrypt: bool('SQL_ENCRYPT', true),
    /* Accept a self-signed server certificate. True is right for a local or
     * private-network MySQL using its own generated certificate; set it false
     * once the server presents one your CA store trusts. */
    trustServerCertificate: bool('SQL_TRUST_CERT', true),
    requestTimeout: int('SQL_TIMEOUT_MS', 900000),
    poolMax: int('SQL_POOL_MAX', 10),
  },

  /* The three databases, named separately because they are restored under
   * whatever names the host site uses. Every cross-database reference in the
   * queries is built from these, never written out literally. */
  databases: {
    data: req('DB_DATA'),
    registry: req('DB_REGISTRY'),
    forms: req('DB_FORMS'),
  },

  arms: {
    /* ARMS starts at 2022 on Louis's instruction, 15 Aug 2026. Earlier returns
     * are still in the database; they are excluded here, not deleted, because
     * up to 86% of condemned organs in the early years were coded "Other" with
     * no diagnosis. A trend across that line measures coding discipline, not
     * disease. Configurable so the cut can be reviewed without a code change. */
    fromYear: int('ARMS_FROM_YEAR', 2022),
    formId: int('ARMS_FORM_ID', 1),
    /* Which abattoirs appear in the inspector's list: those still reporting
     * inside this window. The app's frozen list of 118 was a snapshot of who
     * was reporting on the day it was transcribed; this is the rule behind it,
     * written down and adjustable. */
    abattoirWindowMonths: int('ABATTOIR_WINDOW_MONTHS', 18),
    /* What to do about the 2016 notification trigger on FormData, which
     * hardcodes NAHDIS_FSA..regions and therefore breaks or misfires whenever
     * the registry database is not called exactly that. 'leave' or 'disable' -
     * see the long note in auth/schema.js. */
    /* SQL Server's NAHDIS_FSA.dbo.GetProvince(REG_ID) did not survive the move
     * to MySQL - its body is inside the .bak. This is the SQL expression that
     * yields an abattoir's province in the register query, so it can be
     * corrected in .env once the original function is transcribed. Display
     * only: access scope comes from AppUser.ScopeProvince, not from this. */
    provinceExpr: opt('ARMS_PROVINCE_EXPR', 'r.REG_Name'),
    legacyNotifyTrigger: opt('LEGACY_NOTIFY_TRIGGER', 'leave').toLowerCase(),
    /* Building the explorer payload aggregates roughly 150k rows into 60k.
     * That is a few seconds of SQL, so the result is cached. Set to 0 to
     * disable caching entirely while debugging a query. */
    cacheTtlMs: int('CACHE_TTL_MS', 15 * 60 * 1000),
  },

  paths: {
    systemDir: resolvePath('SYSTEM_DIR', ['app', '../1 - The system']),
    buildDir: resolvePath('BUILD_DIR', ['app', '../2 - How it is built']),
    /* The explorer is served from the template, not from the 2,4 MB built file,
     * because the built file carries a frozen copy of the data and the whole
     * point of this backend is that the figures come from the database. The
     * built file remains the offline artefact and is still downloadable - where
     * it exists. It is not in the repository, so on a fresh server /download/
     * explorer answers "not on this machine" until somebody puts it there. */
    explorerTemplate: resolvePath('EXPLORER_TEMPLATE',
      ['app/explorer-template.html', '../2 - How it is built/explorer-template.html']),
    explorerBuilt: resolvePath('EXPLORER_BUILT',
      ['app/NAHDIS Explorer.html', '../1 - The system/NAHDIS Explorer.html']),
    mobileApp: resolvePath('MOBILE_APP',
      ['app/Schedule 8 Mobile.html', '../1 - The system/Schedule 8 Mobile.html']),
    diseaseMap: resolvePath('DISEASE_MAP',
      ['app/disease-name-map.csv', '../2 - How it is built/disease-name-map.csv']),
  },
};

/* The base URL is derived, never typed twice. */
export function baseUrl() {
  if (config.http.publicUrl) return config.http.publicUrl.replace(/\/+$/, '');
  const shown = config.http.host === '0.0.0.0' || config.http.host === '::'
    ? 'localhost'
    : config.http.host;
  return `http://${shown}:${config.http.port}`;
}

export function validateConfig() {
  const problems = [...missing];

  if (!['leave', 'disable'].includes(config.arms.legacyNotifyTrigger)) {
    problems.push(`LEGACY_NOTIFY_TRIGGER must be "leave" or "disable", got "${config.arms.legacyNotifyTrigger}"`);
  }

  for (const [label, p] of Object.entries({
    'EXPLORER_TEMPLATE': config.paths.explorerTemplate,
    'MOBILE_APP': config.paths.mobileApp,
  })) {
    if (!fs.existsSync(p)) problems.push(`${label} does not exist: ${p}`);
  }

  if (problems.length) {
    const lines = problems.map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `ARMS backend cannot start. Settings missing or wrong in .env:\n${lines}\n\n` +
      `Copy .env.example to .env and fill it in. See README.md.`
    );
  }
}
