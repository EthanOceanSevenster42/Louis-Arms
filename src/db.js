/* One connection pool, shared. Opened lazily on the first query so the HTTP
 * server can come up and report a database problem on a page rather than dying
 * silently at boot.
 *
 * MySQL port. The three databases stay three databases: MySQL treats a schema
 * and a database as the same thing, so `Schedule8Data`.`FormData` is a plain
 * two-part name and the cross-database joins this backend uses everywhere keep
 * working unchanged. That is the one thing Azure SQL could not have given us.
 */
import mysql from 'mysql2/promise';
import { config } from './config.js';

let pool = null;

function buildPoolConfig() {
  const { sql: s } = config;

  return {
    host: s.server,
    port: s.port,
    user: s.user || undefined,
    password: s.password || undefined,

    /* Connect INSIDE the data database. Unqualified names in the ARMS tables
     * then resolve there, and the qualified three-database names still work. */
    database: config.databases.data,

    connectTimeout: 30000,
    waitForConnections: true,
    connectionLimit: s.poolMax,
    queueLimit: 0,
    enableKeepAlive: true,

    /* DECIMAL as a JS number, because the aggregation code sums these itself
     * and a string would concatenate. BIGINT stays exact: the organ counts are
     * within safe-integer range, but a silent precision loss in a national
     * animal-health figure is not a trade worth making. */
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,

    /* Every statement this app sends is a single statement. Leaving this off
     * means a semicolon that reaches the text can never start a second one. */
    multipleStatements: false,

    /* Pin the connection collation to the one the tables were created with.
     *
     * MySQL 8 defaults a connection to utf8mb4_0900_ai_ci. The migrated tables
     * are utf8mb4_unicode_ci. Mix the two in one expression - NULLIF(x,''),
     * a JOIN on two text columns, GetProvince() beside a literal - and MySQL
     * refuses with "Illegal mix of collations" rather than choosing for you.
     * This is the same class of failure the SQL Server original hit between the
     * restored databases and master, and it is fixed the same way: say which
     * collation you mean instead of inheriting one. */
    charset: 'utf8mb4_unicode_ci',

    ssl: s.encrypt
      ? { rejectUnauthorized: !s.trustServerCertificate }
      : undefined,
  };
}

export async function getPool() {
  if (!pool) {
    pool = mysql.createPool(buildPoolConfig());
  }
  return pool;
}

export async function query(text) {
  const p = await getPool();
  const [rows] = await p.query(text);
  return Array.isArray(rows) ? rows : [];
}

/* Parameterised query. EVERYTHING THAT TOUCHES USER INPUT MUST USE THIS.
 *
 * The aggregation queries build their text from configuration - database names,
 * a year, a form id - none of which a visitor can reach. A login form, a
 * captured figure and a search box are the opposite, and escaping quotes by
 * hand is how that goes wrong. Values are bound by the driver and never become
 * part of the statement.
 *
 *   sql`SELECT * FROM arms_AppUser WHERE Username = ${name}`
 *
 * Used as a tagged template, the interpolations become `?` placeholders and the
 * text is fixed at author time, so an injected value has nowhere to go. */
/* A table or column name cannot be a bound parameter - MySQL would read
 * `FROM ?` as a value, not an object. Identifiers built from configuration are
 * wrapped in raw() so they go into the text; everything unwrapped is a value
 * and gets bound. Making that explicit means a plain interpolation can never
 * accidentally become executable. */
const RAW = Symbol('raw-sql');
export const raw = (text) => ({ [RAW]: String(text) });
const isRaw = (v) => v !== null && typeof v === 'object' && RAW in v;

/* Build the statement text and the ordered value list from a tagged template. */
function build(strings, values) {
  let text = '';
  const params = [];
  values.forEach((v, i) => {
    text += strings[i];
    if (isRaw(v)) {
      text += v[RAW];
    } else {
      params.push(v === undefined ? null : v);
      text += '?';
    }
  });
  text += strings[strings.length - 1];
  return { text, params };
}

async function runOn(runner, strings, values) {
  const { text, params } = build(strings, values);
  const [result] = await runner.query(text, params);
  return result;
}

export async function sql(strings, ...values) {
  const p = await getPool();
  const result = await runOn(p, strings, values);
  return Array.isArray(result) ? result : [];
}

/* Same, when the statement returns nothing worth reading. */
export async function exec(strings, ...values) {
  await sql(strings, ...values);
}

/* For INSERT/UPDATE/DELETE, where the caller needs the generated key or the
 * row count. SQL Server got these from OUTPUT INSERTED and @@ROWCOUNT; MySQL
 * returns them on the result header, so they are read rather than selected. */
function header(result) {
  return {
    insertId: result?.insertId ?? null,
    affectedRows: result?.affectedRows ?? 0,
    changedRows: result?.changedRows ?? 0,
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
 * A transaction must run on ONE connection, so it takes a connection out of the
 * pool for its lifetime rather than going through the pool per statement.
 *
 *   await withTransaction(async (t) => {
 *     const { insertId } = await t.run`INSERT INTO ...`;
 *   });
 */
export async function withTransaction(fn) {
  const p = await getPool();
  const conn = await p.getConnection();
  await conn.beginTransaction();

  const t = {
    async sql(strings, ...values) {
      const result = await runOn(conn, strings, values);
      return Array.isArray(result) ? result : [];
    },
    async run(strings, ...values) {
      return header(await runOn(conn, strings, values));
    },
  };
  t.exec = async (strings, ...values) => { await t.sql(strings, ...values); };

  try {
    const out = await fn(t);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* Database names come from configuration, so they reach the query text as
 * identifiers rather than as parameters - and identifiers cannot be bound.
 * Whitelist the characters instead of escaping them: a database name is not
 * user input here, but a settings file is still an input, and a backtick in it
 * should stop the server rather than change what a query means. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;

export function db(name) {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `"${name}" is not a usable MySQL database name. Check DB_DATA, ` +
      `DB_REGISTRY and DB_FORMS in .env - letters, digits and underscores only.`
    );
  }
  return '`' + name + '`';
}

/* Two-part names, assembled from config. MySQL has no schema layer between the
 * database and the table, so SQL Server's three-part db.dbo.table becomes `db`.`table`.
 * The originals in the recovered stored procedures are written out literally
 * (Schedule8Data..FormData), which is exactly why those procedures break the
 * moment a site restores the databases under different names. */
function qualified(dbName, table) {
  if (!SAFE_IDENT.test(table)) {
    throw new Error(`"${table}" is not a usable MySQL table name.`);
  }
  return `${db(dbName)}.\`${table}\``;
}

export const D = {
  data: (table) => qualified(config.databases.data, table),
  registry: (table) => qualified(config.databases.registry, table),
  forms: (table) => qualified(config.databases.forms, table),
};

/* MySQL has no TRY_CONVERT. CAST on a non-numeric string does not raise here -
 * it quietly returns 0 - and a zero that should have been "this figure is
 * unreadable" is exactly the kind of silent wrong number this project exists to
 * stop. Guard the cast with a numeric test so a bad value becomes NULL, which
 * the callers already count and report as Bad. */
export function tryDecimal(expr, precision = '18,3') {
  return `CASE WHEN TRIM(COALESCE(${expr},'')) REGEXP '^[-+]?([0-9]+(\\\\.[0-9]*)?|\\\\.[0-9]+)$' ` +
         `THEN CAST(TRIM(${expr}) AS DECIMAL(${precision})) ELSE NULL END`;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}
