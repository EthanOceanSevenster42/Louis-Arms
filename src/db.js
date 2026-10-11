/* One connection pool, shared. Opened lazily on the first query so the HTTP
 * server can come up and report a database problem on a page rather than dying
 * silently at boot.
 *
 * PostgreSQL. The three databases recovered from SQL Server are three SCHEMAS
 * in one Postgres database: Postgres cannot join across databases, and this
 * backend joins the register to the returns everywhere. `schedule8data.formdata`
 * is a plain two-part name, exactly as `Schedule8Data`.`FormData` was in MySQL.
 */
import pg from 'pg';
import { config } from './config.js';
import { COLUMN_NAMES } from './pg-names.js';

/* Types, read back the way the code has always received them.
 *
 * BIGINT and NUMERIC come back from pg as strings, because neither fits a JS
 * number in general. Here they do: COUNT(*) and the organ sums are far inside
 * safe-integer range, and the aggregation code sums these values itself - a
 * string would concatenate. A sum that ever left that range would be a national
 * figure silently wrong, so it is refused rather than rounded.
 *
 * Two kinds of time, kept apart on purpose:
 *   TIMESTAMPTZ  ARMS's own tables (sessions, audit, accounts, questions).
 *                A real instant, read back as a JS Date.
 *   TIMESTAMP    the recovered data. Eleven years of SQL Server rows written
 *                in South African wall-clock time, with no zone. Read back as
 *                the text it is - '2026-09-09 10:11:00' - because turning it
 *                into a Date means guessing a zone, and the MySQL port guessed
 *                the server's: right on a PC in Pretoria, two hours out on the
 *                UTC droplet. */
const toSafeNumber = (s) => {
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) && Number.isInteger(n)) {
    throw new Error(`integer ${s} is outside the range a figure can be read safely`);
  }
  return n;
};
pg.types.setTypeParser(pg.types.builtins.INT8, toSafeNumber);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (s) => (s === null ? null : Number(s)));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (s) => s);

/* "Now" for a column of the recovered data: South African wall-clock time,
 * the convention every existing row in those tables follows. ARMS's own
 * tables are TIMESTAMPTZ and simply use now(). */
export const SA_NOW = `(now() AT TIME ZONE 'Africa/Johannesburg')`;

let pool = null;

/* A schema or table name from configuration. Whitelisted rather than escaped:
 * a database name is not user input here, but a settings file is still an
 * input, and a quote in it should stop the server rather than change what a
 * query means. Folded to lower case, which is what Postgres does with every
 * unquoted name in the query text - so DB_REGISTRY=NAHDIS_FSA still works. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function ident(name, what) {
  if (!SAFE_IDENT.test(String(name))) {
    throw new Error(
      `"${name}" is not a usable ${what} name. Check DB_DATA, DB_REGISTRY and ` +
      `DB_FORMS in .env - letters, digits and underscores only.`
    );
  }
  return String(name).toLowerCase();
}

function buildPoolConfig() {
  const { sql: s } = config;
  return {
    host: s.server,
    port: s.port,
    database: s.database,
    user: s.user || undefined,
    password: s.password || undefined,
    max: s.poolMax,
    connectionTimeoutMillis: 30000,
    statement_timeout: s.requestTimeout,
    keepAlive: true,
    ssl: s.encrypt ? { rejectUnauthorized: !s.trustServerCertificate } : false,

    /* Unqualified names - FormData, FormDataItems - resolve in the data schema,
     * as they did when the MySQL connection opened inside the data database.
     * The session runs in UTC; TIMESTAMPTZ values are instants either way. */
    options: `-c search_path=${ident(config.databases.data, 'schema')},public -c timezone=UTC`,
  };
}

export async function getPool() {
  if (!pool) {
    pool = new pg.Pool(buildPoolConfig());
    /* An idle client dropped by the server must not take the process with it;
     * the next query simply gets a fresh connection. */
    pool.on('error', (err) => console.error(`  database pool: ${err.message}`));
  }
  return pool;
}

/* ---------------------------------------------------------------------------
 * Column names, as the code spells them.
 *
 * Postgres folds every unquoted identifier to lower case, so `SELECT FRMD_Id`
 * comes back as { frmd_id } where the code reads r.FRMD_Id. Rather than quote
 * every name in every query, the spelling is restored from the query's own
 * text: whichever way the statement wrote a name is the way the row carries
 * it. A name written two ways in one statement (FRMD_Id and FRMD_ID are both
 * real columns) is carried under both. A name the text does not spell - a
 * SELECT *, a column from a fragment - falls back to the schema's own list.
 * ------------------------------------------------------------------------- */
const KNOWN = new Map();
for (const n of COLUMN_NAMES) {
  const k = n.toLowerCase();
  if (!KNOWN.has(k)) KNOWN.set(k, new Set());
  KNOWN.get(k).add(n);
}

const spellingCache = new Map();

function spellings(text) {
  let found = spellingCache.get(text);
  if (found) return found;
  found = new Map();
  /* Names only: a quoted value - 'Approved', 'YYYY-MM' - and a comment are
   * not spellings of anything, and would add stray keys to the row. */
  const names = text.replace(/'(?:[^']|'')*'/g, ' ').replace(/--[^\r\n]*/g, ' ');
  for (const m of names.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const k = m[0].toLowerCase();
    if (!found.has(k)) found.set(k, new Set());
    found.get(k).add(m[0]);
  }
  if (spellingCache.size > 2000) spellingCache.clear();
  spellingCache.set(text, found);
  return found;
}

function shapeRows(result, text) {
  if (!result || !Array.isArray(result.rows) || !result.fields) return [];
  const words = spellings(text);
  const keys = result.fields.map((f) => [...(words.get(f.name) || KNOWN.get(f.name) || [f.name])]);
  return result.rows.map((values) => {
    const row = {};
    for (let i = 0; i < keys.length; i++) {
      for (const k of keys[i]) row[k] = values[i];
    }
    return row;
  });
}

async function exec_(runner, text, params = []) {
  const result = await runner.query({ text, values: params, rowMode: 'array' });
  return { rows: shapeRows(result, text), rowCount: result.rowCount ?? 0 };
}

export async function query(text) {
  const p = await getPool();
  return (await exec_(p, text)).rows;
}

/* Parameterised query. EVERYTHING THAT TOUCHES USER INPUT MUST USE THIS.
 *
 * The aggregation queries build their text from configuration - schema names,
 * a year, a form id - none of which a visitor can reach. A login form, a
 * captured figure and a search box are the opposite, and escaping quotes by
 * hand is how that goes wrong. Values are bound by the driver and never become
 * part of the statement.
 *
 *   sql`SELECT * FROM arms.AppUser WHERE Username = ${name}`
 *
 * Used as a tagged template, the interpolations become $1, $2... placeholders
 * and the text is fixed at author time, so an injected value has nowhere to go.
 *
 * A table or column name cannot be a bound parameter. Identifiers built from
 * configuration are wrapped in raw() so they go into the text; everything
 * unwrapped is a value and gets bound. Making that explicit means a plain
 * interpolation can never accidentally become executable. */
const RAW = Symbol('raw-sql');
export const raw = (text) => ({ [RAW]: String(text) });
const isRaw = (v) => v !== null && typeof v === 'object' && RAW in v;

/* Build the statement text and the ordered value list from a tagged template.
 * Booleans go in as 1 and 0: the flag columns are smallint, as they were
 * tinyint(1) and bit before, and Postgres will not read true as a number. */
function build(strings, values) {
  let text = '';
  const params = [];
  values.forEach((v, i) => {
    text += strings[i];
    if (isRaw(v)) {
      text += v[RAW];
    } else {
      params.push(v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
      text += `$${params.length}`;
    }
  });
  text += strings[strings.length - 1];
  return { text, params };
}

async function runOn(runner, strings, values) {
  const { text, params } = build(strings, values);
  return exec_(runner, text, params);
}

export async function sql(strings, ...values) {
  const p = await getPool();
  return (await runOn(p, strings, values)).rows;
}

/* Same, when the statement returns nothing worth reading. */
export async function exec(strings, ...values) {
  await sql(strings, ...values);
}

/* For INSERT/UPDATE/DELETE, where the caller needs the generated key or the
 * row count. Postgres hands back a key only when asked, so an INSERT whose key
 * is wanted says RETURNING <key>; insertId is the first column of the first
 * row it returns. affectedRows is the number of rows the statement matched. */
function header(result) {
  const first = result.rows[0];
  return {
    insertId: first ? Object.values(first)[0] ?? null : null,
    affectedRows: result.rowCount,
  };
}

export async function run(strings, ...values) {
  const p = await getPool();
  return header(await runOn(p, strings, values));
}

/* A transaction, with the same bound-parameter discipline.
 *
 * A Schedule 8 return is one FormData row, up to a few hundred FormDataItems
 * and their FormDataItemParts. Written without a transaction, a failure
 * halfway leaves a return that exists but is missing its offal - and an offal
 * count that silently is not there is precisely the defect this whole project
 * exists to correct. All of it lands, or none of it does.
 *
 * A transaction must run on ONE connection, so it takes a client out of the
 * pool for its lifetime rather than going through the pool per statement.
 *
 *   await withTransaction(async (t) => {
 *     const { insertId } = await t.run`INSERT INTO ... RETURNING FRMD_Id`;
 *   });
 */
export async function withTransaction(fn) {
  const p = await getPool();
  const client = await p.connect();
  await client.query('BEGIN');

  const t = {
    async sql(strings, ...values) {
      return (await runOn(client, strings, values)).rows;
    },
    async run(strings, ...values) {
      return header(await runOn(client, strings, values));
    },
  };
  t.exec = async (strings, ...values) => { await t.sql(strings, ...values); };

  try {
    const out = await fn(t);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* A schema name from configuration, ready for the query text. */
export function db(name) {
  return ident(name, 'schema');
}

/* Two-part names, assembled from config. The originals in the recovered stored
 * procedures are written out literally (Schedule8Data..FormData), which is
 * exactly why those procedures break the moment a site restores the databases
 * under different names. */
function qualified(schema, table) {
  return `${db(schema)}.${ident(table, 'table')}`;
}

export const D = {
  data: (table) => qualified(config.databases.data, table),
  registry: (table) => qualified(config.databases.registry, table),
  forms: (table) => qualified(config.databases.forms, table),
};

/* A cast that cannot invent a zero. Postgres raises on a non-numeric cast,
 * which would fail a whole report over one bad cell; MySQL quietly returned 0,
 * which was worse. Guard the cast with a numeric test so a bad value becomes
 * NULL, which the callers already count and report as Bad. The test runs in
 * the "C" collation because a case-insensitive collation cannot run a regex. */
export function tryDecimal(expr, precision = '18,3') {
  return `CASE WHEN TRIM(COALESCE(${expr},'')) COLLATE "C" ~ '^[-+]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)$' ` +
         `THEN CAST(TRIM(${expr}) AS NUMERIC(${precision})) ELSE NULL END`;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}
