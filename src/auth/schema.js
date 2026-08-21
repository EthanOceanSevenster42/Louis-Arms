/* The tables ARMS adds, and the one legacy column it has to widen.
 *
 * MySQL has no schema layer inside a database, so what was the `arms` schema in
 * SQL Server is its own database here, named `arms`. Every reference in the code
 * is already written `arms.AppUser`, which reads correctly either way.
 *
 * Nothing in the recovered data is dropped, renamed or repurposed - those tables
 * are an eleven-year evidential record and this sits beside them, clearly marked
 * as new. Running this twice is safe.
 */
import { query, sql, db } from '../db.js';
import { config } from '../config.js';

const DATA = () => config.databases.data;
const ARMS = 'arms';

/* MySQL has no CREATE INDEX IF NOT EXISTS, so the catalogue is asked first.
 * Creating an index that already exists is an error, not a no-op, and this
 * migration has to stay safe to re-run. */
async function indexExists(schema, table, name) {
  const [row] = await sql`
SELECT COUNT(*) AS n
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ${schema} AND TABLE_NAME = ${table} AND INDEX_NAME = ${name}`;
  return Number(row?.n || 0) > 0;
}

async function createIndex(schema, table, name, definition, log) {
  if (await indexExists(schema, table, name)) {
    log(`    ok  ${name} (already present)`);
    return;
  }
  await query(`CREATE INDEX \`${name}\` ON ${db(schema)}.\`${table}\` ${definition}`);
  log(`    ok  ${name}`);
}

/* ---------------------------------------------------------------------------
 * THE ONE LEGACY CHANGE: FDI_Item varchar(50) -> varchar(100).
 *
 * `Porcine Reproductive and Respiratory Syndrome (PRRS)` is 52 characters and
 * is an official controlled-disease name on the form. Written into a
 * varchar(50) it silently loses its last two characters, and a controlled
 * disease that does not match its own name is a disease that never gets
 * counted. The longest value in eleven years of existing data is 33
 * characters, so nothing already recorded is affected.
 *
 * The handover names this explicitly: "Widen the column before any new capture
 * path writes to it." This is that capture path.
 * ------------------------------------------------------------------------- */
async function widenItemColumn() {
  const [col] = await sql`
SELECT CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable, COLUMN_TYPE AS coltype
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${DATA()} AND TABLE_NAME = 'FormDataItems' AND COLUMN_NAME = 'FDI_Item'`;

  if (!col) throw new Error('FormDataItems.FDI_Item not found - is DB_DATA the right database?');
  const len = col.len === null ? -1 : Number(col.len);
  if (len >= 100 || len === -1) return { changed: false, from: len };

  /* An index on the column would have to be dropped and rebuilt; refuse rather
   * than silently reshape somebody's index. There is none today. */
  const [idx] = await sql`
SELECT COUNT(*) AS n
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ${DATA()} AND TABLE_NAME = 'FormDataItems' AND COLUMN_NAME = 'FDI_Item'`;
  if (Number(idx.n) > 0) {
    throw new Error(
      'FDI_Item is part of an index. Widening it needs that index dropped and rebuilt - ' +
      'do it deliberately rather than as a side effect of starting the backend.'
    );
  }

  await query(
    `ALTER TABLE ${db(DATA())}.\`FormDataItems\` MODIFY COLUMN FDI_Item VARCHAR(100) NOT NULL`
  );
  return { changed: true, from: len };
}

/* ---------------------------------------------------------------------------
 * ARMS's own tables.
 *
 * Types, translated from the SQL Server original:
 *   nvarchar(n)  -> VARCHAR(n)   (the database is utf8mb4, so every column is
 *                                 already Unicode; nvarchar has no counterpart)
 *   nvarchar(max)-> TEXT
 *   bit          -> TINYINT(1)
 *   datetime2(0) -> DATETIME     (second precision, same as the original)
 *   IDENTITY(1,1)-> AUTO_INCREMENT
 * ------------------------------------------------------------------------- */
const STATEMENTS = [
  [`the arms database`, `CREATE DATABASE IF NOT EXISTS \`${ARMS}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`],

  /* A user is scoped to an abattoir, an admin to a province, a super user to
   * the country. Both scopes already exist in the data - the abattoir's ORG_ID
   * and the province derived from its RC number - so no new hierarchy is
   * needed, exactly as the specification says. */
  [`arms.AppUser`, `
CREATE TABLE IF NOT EXISTS \`${ARMS}\`.\`AppUser\` (
  UserId             INT AUTO_INCREMENT PRIMARY KEY,
  Username           VARCHAR(64)  NOT NULL UNIQUE,
  FullName           VARCHAR(120) NOT NULL,
  Email              VARCHAR(160) NULL,
  PasswordHash       VARCHAR(400) NOT NULL,
  -- 'user' = inspector at one abattoir, 'admin' = regional manager for one
  -- province, 'super' = national. Capture and approval are never the same
  -- person, which is why these are layers and not flags on one role.
  Role               VARCHAR(10)  NOT NULL,
  ScopeOrgId         INT          NULL,      -- set for 'user'
  ScopeProvince      VARCHAR(40)  NULL,      -- set for 'admin'
  IsActive           TINYINT(1)   NOT NULL DEFAULT 1,
  MustChangePassword TINYINT(1)   NOT NULL DEFAULT 1,
  FailedAttempts     INT          NOT NULL DEFAULT 0,
  LockedUntil        DATETIME     NULL,
  LegacyUsrId        INT          NULL,      -- NAHDIS_FSA.Users.Id, for attribution
  CreatedAt          DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  CreatedBy          VARCHAR(64)  NULL,
  LastLoginAt        DATETIME     NULL,
  CONSTRAINT CK_AppUser_Role CHECK (Role IN ('user','admin','super')),
  -- The scope must match the layer. An admin with an abattoir scope, or a user
  -- with none, is a permission bug waiting to happen; the database refuses it.
  -- MySQL enforces CHECK constraints from 8.0.16; on anything older these are
  -- parsed and ignored, which is why scope.js checks in code as well.
  CONSTRAINT CK_AppUser_Scope CHECK (
        (Role = 'user'  AND ScopeOrgId IS NOT NULL AND ScopeProvince IS NULL)
     OR (Role = 'admin' AND ScopeOrgId IS NULL     AND ScopeProvince IS NOT NULL)
     OR (Role = 'super' AND ScopeOrgId IS NULL     AND ScopeProvince IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],

  /* Sessions live in the database rather than only in a signed cookie, so that
   * access can actually be revoked - a super user removing an account must end
   * that person's session, not wait for a cookie to expire. */
  [`arms.Session`, `
CREATE TABLE IF NOT EXISTS \`${ARMS}\`.\`Session\` (
  SessionId   INT AUTO_INCREMENT PRIMARY KEY,
  TokenHash   CHAR(64)     NOT NULL UNIQUE,   -- SHA-256 of the cookie value
  UserId      INT          NOT NULL,
  CreatedAt   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  ExpiresAt   DATETIME     NOT NULL,
  LastSeenAt  DATETIME     NULL,
  RevokedAt   DATETIME     NULL,
  IpAddress   VARCHAR(64)  NULL,
  UserAgent   VARCHAR(300) NULL,
  CONSTRAINT FK_Session_User FOREIGN KEY (UserId)
    REFERENCES \`${ARMS}\`.\`AppUser\` (UserId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],

  /* "Assume audit from the start. Who saw what matters less than who CHANGED
   * what, but a disease investigation may ask both." */
  [`arms.AuditLog`, `
CREATE TABLE IF NOT EXISTS \`${ARMS}\`.\`AuditLog\` (
  AuditId    BIGINT AUTO_INCREMENT PRIMARY KEY,
  At         DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UserId     INT          NULL,
  Username   VARCHAR(64)  NULL,
  Action     VARCHAR(40)  NOT NULL,
  EntityType VARCHAR(30)  NULL,
  EntityId   VARCHAR(60)  NULL,
  Detail     TEXT         NULL,
  IpAddress  VARCHAR(64)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
];

/* Indexes are created separately because MySQL has no IF NOT EXISTS for them.
 * The SQL Server original used INCLUDE columns on the FormData index; MySQL has
 * no INCLUDE, so those columns join the key itself - same covering effect, at
 * the cost of a slightly wider index. */
const INDEXES = [
  [ARMS, 'Session', 'IX_Session_User', '(UserId, ExpiresAt)'],
  [ARMS, 'AuditLog', 'IX_Audit_At', '(At DESC)'],
  [null, 'FormData', 'IX_FormData_Org_Period', '(ORG_ID, FRMD_StartDate, FRMD_Status, FRMD_Revision)'],
  [null, 'FormDataItems', 'IX_FormDataItems_Return', '(FRMD_ID)'],
  [null, 'FormDataItemParts', 'IX_FormDataItemParts_Item', '(FDI_ID)'],
];

/* ---------------------------------------------------------------------------
 * THE LEGACY NOTIFICATION TRIGGER.
 *
 * In SQL Server, FormData carried trig_FormData_CheckNotifiableDeseases,
 * written in 2016. It fired AFTER UPDATE, noticed a return becoming Approved,
 * and sent a controlled-disease notification through sp_SendMail - writing
 * three-part names out literally (`NAHDIS_FSA..regions`), which is why it broke
 * whenever the databases were restored under other names.
 *
 * On MySQL that trigger does not exist unless somebody recreated it during the
 * data migration: sp_SendMail has no MySQL counterpart, so it almost certainly
 * was not carried across. This function therefore REPORTS what it finds rather
 * than changing anything.
 *
 * Two things differ from the SQL Server version and both matter:
 *   - MySQL has no DISABLE TRIGGER. The only way to stop one is to DROP it,
 *     which is destructive and irreversible without the definition. So
 *     LEGACY_NOTIFY_TRIGGER=disable is reported here, not acted on.
 *   - If no trigger is found, controlled-disease notification is sent by
 *     NOTHING. ARMS does not send it either. That is a real gap and is printed
 *     every run rather than buried.
 * ------------------------------------------------------------------------- */
async function handleLegacyTrigger(log) {
  const rows = await sql`
SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
FROM information_schema.TRIGGERS
WHERE EVENT_OBJECT_SCHEMA = ${DATA()} AND EVENT_OBJECT_TABLE = 'FormData'`;

  if (!rows.length) {
    log('    no trigger on FormData (expected: sp_SendMail did not survive the move to MySQL)');
    log('    NOTE: controlled-disease notification is sent by nothing.');
    log('          ARMS does not yet send it. This is a known gap, not a fix.');
    return;
  }

  for (const t of rows) {
    log(`    found trigger ${t.name} (${t.timing} ${t.event}) on FormData`);
    if (config.arms.legacyNotifyTrigger === 'disable') {
      log('          LEGACY_NOTIFY_TRIGGER=disable, but MySQL cannot disable a trigger.');
      log(`          Drop it deliberately if that is what you want:`);
      log(`            DROP TRIGGER \`${DATA()}\`.\`${t.name}\`;`);
      log('          Save its definition first - a dropped trigger is gone.');
    } else {
      log('          left alone (LEGACY_NOTIFY_TRIGGER=leave). If it was ported from the');
      log(`          original it may still reference NAHDIS_FSA literally rather than ${config.databases.registry}.`);
    }
  }
}

export async function migrate({ log = console.log } = {}) {
  log('  migrating the data database...');

  const widened = await widenItemColumn();
  log(widened.changed
    ? `    FDI_Item widened from varchar(${widened.from}) to varchar(100) — PRRS is 52 characters`
    : `    FDI_Item already wide enough (${widened.from === -1 ? 'max' : widened.from})`);

  for (const [label, statement] of STATEMENTS) {
    await query(statement);
    log(`    ok  ${label}`);
  }

  for (const [schema, table, name, definition] of INDEXES) {
    await createIndex(schema ?? DATA(), table, name, definition, log);
  }

  await handleLegacyTrigger(log);

  log('  migration complete');
}
