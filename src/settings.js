/* The values that get tuned, kept in the database rather than in .env.
 *
 * WHY THE DATABASE AND NOT .env
 *   Changing the ARMS start year, the reporting window or the cache lifetime
 *   should not need a file edit, a deploy and a restart. These are decisions the
 *   people running ARMS make, not deployment facts, and they are the sort of
 *   thing somebody will want to change at 16:40 on a Friday. They live in
 *   arms.Setting, are read at start-up, and can be re-read without a restart.
 *
 * WHAT STAYS IN .env, DELIBERATELY
 *   Everything needed to reach the database: host, port, credentials, and the
 *   three database names. Those cannot be read from the database without
 *   already being connected to it. The same goes for PORT and HOST - the
 *   process must know where to listen before it can ask anything.
 *
 * PRECEDENCE
 *   arms.Setting  >  .env  >  the default written here.
 *   A row that is missing or unreadable falls back rather than failing: a
 *   national animal-health system should not refuse to start because somebody
 *   deleted a settings row.
 */
import { sql, exec, raw } from './db.js';
import { config } from './config.js';
import { setRcProvinces, RC_PROV } from './rc.js';

/* Every tunable, with where it lands in config and how to read it back.
 * `parse` turns the stored text into the type the code expects; `format` turns
 * the current value into the text that seeds the table on first run. */
export const TUNABLES = [
  {
    name: 'arms.fromYear',
    path: ['arms', 'fromYear'],
    parse: (v) => parseInt(v, 10),
    validate: (n) => Number.isInteger(n) && n >= 2000 && n <= 2100,
    description:
      'ARMS reports from this year. Earlier returns stay in the database and are ' +
      'excluded, not deleted - up to 86% of condemned organs in the early years ' +
      'were coded "Other" with no diagnosis, so a trend across that line measures ' +
      'coding discipline rather than disease.',
  },
  {
    name: 'arms.formId',
    path: ['arms', 'formId'],
    parse: (v) => parseInt(v, 10),
    validate: (n) => Number.isInteger(n) && n > 0,
    description: 'Which form in Schedule8.Forms the Schedule 8 return is.',
  },
  {
    name: 'arms.abattoirWindowMonths',
    path: ['arms', 'abattoirWindowMonths'],
    parse: (v) => parseInt(v, 10),
    validate: (n) => Number.isInteger(n) && n >= 1 && n <= 240,
    description:
      'An inspector may file for abattoirs still reporting inside this window, ' +
      'measured back from the most recent return in the database.',
  },
  {
    name: 'arms.cacheTtlMs',
    path: ['arms', 'cacheTtlMs'],
    parse: (v) => parseInt(v, 10),
    validate: (n) => Number.isInteger(n) && n >= 0 && n <= 24 * 60 * 60 * 1000,
    description:
      'How long a built explorer payload is held before it is rebuilt from SQL. ' +
      '0 disables caching, which is useful while debugging a query and slow otherwise.',
  },
  {
    name: 'arms.provinceExpr',
    path: ['arms', 'provinceExpr'],
    parse: (v) => String(v),
    validate: (v) => typeof v === 'string' && v.trim().length > 0 && !v.includes(';'),
    description:
      'SQL expression yielding an abattoir province in the register query. ' +
      'Display only - access scope comes from AppUser.ScopeProvince, never this.',
  },
  {
    name: 'arms.legacyNotifyTrigger',
    path: ['arms', 'legacyNotifyTrigger'],
    parse: (v) => String(v).toLowerCase(),
    validate: (v) => v === 'leave' || v === 'disable',
    description:
      'What to do about the 2016 notification trigger on FormData: "leave" or ' +
      '"disable". See the long note in auth/schema.js.',
  },
  {
    name: 'http.sessionHours',
    path: ['http', 'sessionHours'],
    parse: (v) => parseInt(v, 10),
    validate: (n) => Number.isInteger(n) && n >= 1 && n <= 720,
    description: 'How long a sign-in lasts before it must be repeated.',
  },
];

function getPath(obj, path) {
  return path.reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const last = path[path.length - 1];
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj);
  parent[last] = value;
}

/* Create the tables and seed them from whatever is in force right now, so the
 * first run records the current behaviour rather than inventing new defaults. */
export async function ensureSettingsTables(log = () => {}) {
  await exec`
CREATE TABLE IF NOT EXISTS arms.Setting (
  Name        VARCHAR(64)  NOT NULL PRIMARY KEY,
  Value       VARCHAR(500) NOT NULL,
  Description VARCHAR(600) NULL,
  UpdatedAt   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UpdatedBy   VARCHAR(64)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  /* The RC number's first digit encodes the province, and that mapping is also
   * the scope of an admin's authority - see the note at the top of rc.js. It is
   * here so it can be corrected if the numbering is ever extended, NOT so the
   * register can disagree with it. One row per digit, one place to change. */
  await exec`
CREATE TABLE IF NOT EXISTS arms.RcProvince (
  Digit    CHAR(1)     NOT NULL PRIMARY KEY,
  Province VARCHAR(40) NOT NULL,
  UpdatedAt DATETIME   NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  for (const t of TUNABLES) {
    const current = getPath(config, t.path);
    await exec`
INSERT INTO arms.Setting (Name, Value, Description, UpdatedBy)
VALUES (${t.name}, ${String(current)}, ${t.description}, 'seed')
ON DUPLICATE KEY UPDATE Description = VALUES(Description)`;
  }
  log(`    ok  arms.Setting (${TUNABLES.length} tunables)`);

  for (const [digit, province] of Object.entries(RC_PROV)) {
    await exec`
INSERT INTO arms.RcProvince (Digit, Province) VALUES (${digit}, ${province})
ON DUPLICATE KEY UPDATE Province = VALUES(Province)`;
  }
  const [{ n }] = await sql`SELECT COUNT(*) AS n FROM arms.RcProvince`;
  log(`    ok  arms.RcProvince (${n} provinces)`);
}

/* Read the tables and overlay them onto config. Called at start-up, and safe to
 * call again to pick up a change without a restart. Returns what it applied so
 * the caller can log it. */
export async function loadSettings({ log = () => {} } = {}) {
  const applied = [];
  try {
    const rows = await sql`SELECT Name, Value FROM arms.Setting`;
    const byName = new Map(rows.map((r) => [r.Name, r.Value]));

    for (const t of TUNABLES) {
      if (!byName.has(t.name)) continue;
      const parsed = t.parse(byName.get(t.name));
      if (!t.validate(parsed)) {
        log(`    settings: ignoring arms.Setting '${t.name}' = ${JSON.stringify(byName.get(t.name))} (not valid)`);
        continue;
      }
      const before = getPath(config, t.path);
      if (before !== parsed) {
        setPath(config, t.path, parsed);
        applied.push(`${t.name}: ${before} -> ${parsed}`);
      }
    }

    const provs = await sql`SELECT Digit, Province FROM arms.RcProvince ORDER BY Digit`;
    if (provs.length) {
      const map = {};
      for (const p of provs) map[String(p.Digit)] = String(p.Province);
      setRcProvinces(map);
      applied.push(`provinces: ${provs.length} from arms.RcProvince`);
    }
  } catch (err) {
    /* Before init-db has run these tables do not exist. That is not a failure -
     * it is the first boot - so .env and the defaults stand and the app starts. */
    log(`    settings: using .env defaults (${err.message.split('\n')[0]})`);
  }
  return applied;
}

/* Change one, from the admin desk or a console. Validated against the same rule
 * the loader uses, so a bad value is refused at the point somebody types it
 * rather than silently ignored at the next restart. */
export async function putSetting(name, value, updatedBy = null) {
  const t = TUNABLES.find((x) => x.name === name);
  if (!t) throw new Error(`"${name}" is not a setting ARMS knows about.`);
  const parsed = t.parse(String(value));
  if (!t.validate(parsed)) throw new Error(`"${value}" is not a usable value for ${name}.`);
  await exec`
INSERT INTO arms.Setting (Name, Value, Description, UpdatedBy)
VALUES (${name}, ${String(value)}, ${t.description}, ${updatedBy})
ON DUPLICATE KEY UPDATE Value = VALUES(Value), UpdatedBy = VALUES(UpdatedBy),
                        UpdatedAt = UTC_TIMESTAMP()`;
  setPath(config, t.path, parsed);
  return parsed;
}

export async function listSettings() {
  return sql`SELECT Name, Value, Description, UpdatedAt, UpdatedBy
             FROM arms.Setting ORDER BY Name`;
}
