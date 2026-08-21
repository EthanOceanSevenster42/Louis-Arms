/* One connection pool, shared. Opened lazily on the first query so the HTTP
 * server can come up and report a database problem on a page rather than dying
 * silently at boot.
 */
import mssql from 'mssql';
import { config } from './config.js';

let poolPromise = null;

function buildPoolConfig() {
  const { sql: s } = config;

  const base = {
    server: s.server,
    user: s.user || undefined,
    password: s.password || undefined,
    /* Connect INSIDE the data database, not to the login's default.
     *
     * This is not cosmetic. The restored databases collate Latin1_General_CI_AS
     * and this instance's master collates SQL_Latin1_General_CP1_CI_AS, so a
     * query that compares a varchar against a literal - every ISNULL(NULLIF(
     * x,''),'Unknown') in the register query - resolves the literal in the
     * connection's collation and fails with a collation conflict. The
     * PowerShell extractor always connected with Database=Schedule8Data and so
     * never met this; running the same SQL from master does. */
    database: config.databases.data,
    requestTimeout: s.requestTimeout,
    connectionTimeout: 30000,
    pool: { max: s.poolMax, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: s.encrypt,
      trustServerCertificate: s.trustServerCertificate,
      enableArithAbort: true,
      /* Without this the driver hands back the raw column name only; the
       * queries below rely on the aliases they declare. */
      useUTC: false,
    },
  };

  /* A named instance is resolved by the SQL Browser service and must not also
   * carry a port; a default instance needs the port and no instance name.
   * Sending both makes tedious ignore the port silently, which looks like a
   * firewall problem and is not. */
  if (s.instance) {
    base.options.instanceName = s.instance;
  } else {
    base.port = s.port;
  }

  if (s.auth === 'windows') {
    /* Integrated security needs the native driver (msnodesqlv8), which is a
     * compiled dependency and Windows-only. SQL authentication with a
     * read-only login is the portable choice and the one the FSA server will
     * need if it turns out to be Linux - handover question 1. */
    throw new Error(
      'SQL_AUTH=windows requires the msnodesqlv8 native driver, which is not installed ' +
      'and does not exist for Linux. Use SQL_AUTH=sql with a read-only login instead.'
    );
  }

  return base;
}

export async function getPool() {
  if (!poolPromise) {
    poolPromise = new mssql.ConnectionPool(buildPoolConfig())
      .connect()
      .catch((err) => {
        poolPromise = null;  // let the next request try again
        throw err;
      });
  }
  return poolPromise;
}

export async function query(text) {
  const pool = await getPool();
  const result = await pool.request().query(text);
  return result.recordset || [];
}

/* Parameterised query. EVERYTHING THAT TOUCHES USER INPUT MUST USE THIS.
 *
 * The aggregation queries build their text from configuration - database names,
 * a year, a form id - none of which a visitor can reach. A login form, a
 * captured figure and a search box are the opposite, and escaping quotes by
 * hand is how that goes wrong. Values are bound by the driver and never become
 * part of the statement.
 *
 *   sql`SELECT * FROM arms.AppUser WHERE Username = ${name}`
 *
 * Used as a tagged template, the interpolations become @p0, @p1 ... and the
 * text is fixed at author time, so an injected value has nowhere to go. */
/* A table or column name cannot be a bound parameter - SQL Server would read
 * `FROM @p0` as a value, not an object. Identifiers built from configuration
 * are wrapped in raw() so they go into the text; everything unwrapped is a
 * value and gets bound. Making that explicit means a plain interpolation can
 * never accidentally become executable. */
const RAW = Symbol('raw-sql');
export const raw = (text) => ({ [RAW]: String(text) });
const isRaw = (v) => v !== null && typeof v === 'object' && RAW in v;

export async function sql(strings, ...values) {
  const pool = await getPool();
  const request = pool.request();

  let text = '';
  let bound = 0;
  values.forEach((v, i) => {
    text += strings[i];
    if (isRaw(v)) {
      text += v[RAW];
    } else {
      const name = `p${bound++}`;
      request.input(name, v === undefined ? null : v);
      text += `@${name}`;
    }
  });
  text += strings[strings.length - 1];

  const result = await request.query(text);
  return result.recordset || [];
}

/* Same, when the statement returns nothing worth reading. */
export async function exec(strings, ...values) {
  await sql(strings, ...values);
}

/* A transaction, with the same bound-parameter discipline.
 *
 * A Schedule 8 return is one FormData row, up to a few hundred FormDataItems
 * and their FormDataItemParts. Written without a transaction, a failure
 * halfway leaves a return that exists but is missing its offal - and an offal
 * count that silently is not there is precisely the defect this whole project
 * exists to correct. All of it lands, or none of it does.
 *
 *   await withTransaction(async (t) => {
 *     const id = await t.sql`INSERT ... SELECT SCOPE_IDENTITY() AS id`;
 *   });
 */
export async function withTransaction(fn) {
  const pool = await getPool();
  const tx = new mssql.Transaction(pool);
  await tx.begin();

  const t = {
    async sql(strings, ...values) {
      const request = new mssql.Request(tx);
      let text = '';
      let bound = 0;
      values.forEach((v, i) => {
        text += strings[i];
        if (isRaw(v)) {
          text += v[RAW];
        } else {
          const name = `p${bound++}`;
          request.input(name, v === undefined ? null : v);
          text += `@${name}`;
        }
      });
      text += strings[strings.length - 1];
      const result = await request.query(text);
      return result.recordset || [];
    },
  };

  try {
    const out = await fn(t);
    await tx.commit();
    return out;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/* Database names come from configuration, so they reach the query text as
 * identifiers rather than as parameters - and identifiers cannot be bound.
 * Whitelist the characters instead of escaping them: a database name is not
 * user input here, but a settings file is still an input, and a bracket in it
 * should stop the server rather than change what a query means. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$#@]{0,127}$/;

export function db(name) {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `"${name}" is not a usable SQL Server database name. Check DB_DATA, ` +
      `DB_REGISTRY and DB_FORMS in .env - letters, digits and underscores only.`
    );
  }
  return `[${name}]`;
}

/* Three-part names, assembled from config. The originals in the recovered
 * stored procedures are written out literally (Schedule8Data..FormData), which
 * is exactly why those procedures break the moment a site restores the
 * databases under different names - as this machine did. */
export const D = {
  data: (table) => `${db(config.databases.data)}.dbo.${table}`,
  registry: (table) => `${db(config.databases.registry)}.dbo.${table}`,
  forms: (table) => `${db(config.databases.forms)}.dbo.${table}`,
};

export async function closePool() {
  if (poolPromise) {
    const pool = await poolPromise.catch(() => null);
    poolPromise = null;
    if (pool) await pool.close().catch(() => {});
  }
}
