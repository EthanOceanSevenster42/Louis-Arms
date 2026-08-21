/* The tables ARMS adds, and the one legacy column it has to widen.
 *
 * Everything ARMS owns lives in its own `arms` schema inside the data database.
 * Nothing in `dbo` is dropped, renamed or repurposed - the recovered tables are
 * an eleven-year evidential record and this sits beside them, clearly marked as
 * new. Running this twice is safe.
 */
import { query, db } from '../db.js';
import { config } from '../config.js';

const D = () => db(config.databases.data);

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
  const [col] = await query(`
SELECT c.max_length AS len, c.is_nullable AS nullable
FROM ${D()}.sys.columns c
JOIN ${D()}.sys.objects o ON o.object_id = c.object_id
WHERE o.name = 'FormDataItems' AND c.name = 'FDI_Item'`);

  if (!col) throw new Error('FormDataItems.FDI_Item not found - is DB_DATA the right database?');
  if (col.len >= 100 || col.len === -1) return { changed: false, from: col.len };

  /* An index on the column would have to be dropped and rebuilt; refuse rather
   * than silently reshape somebody's index. There is none today. */
  const [idx] = await query(`
SELECT COUNT(*) AS n
FROM ${D()}.sys.index_columns ic
JOIN ${D()}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN ${D()}.sys.objects o ON o.object_id = ic.object_id
WHERE o.name = 'FormDataItems' AND c.name = 'FDI_Item'`);
  if (Number(idx.n) > 0) {
    throw new Error(
      'FDI_Item is part of an index. Widening it needs that index dropped and rebuilt - ' +
      'do it deliberately rather than as a side effect of starting the backend.'
    );
  }

  await query(`ALTER TABLE ${D()}.dbo.FormDataItems ALTER COLUMN FDI_Item varchar(100) NOT NULL`);
  return { changed: true, from: col.len };
}

/* ---------------------------------------------------------------------------
 * ARMS's own tables.
 * ------------------------------------------------------------------------- */
const STATEMENTS = [
  [`the arms schema`, `
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arms')
  EXEC('CREATE SCHEMA arms')`],

  /* A user is scoped to an abattoir, an admin to a province, a super user to
   * the country. Both scopes already exist in the data - the abattoir's ORG_ID
   * and the province derived from its RC number - so no new hierarchy is
   * needed, exactly as the specification says. */
  [`arms.AppUser`, `
IF OBJECT_ID('arms.AppUser') IS NULL
CREATE TABLE arms.AppUser (
  UserId            int IDENTITY(1,1) PRIMARY KEY,
  Username          nvarchar(64)  NOT NULL UNIQUE,
  FullName          nvarchar(120) NOT NULL,
  Email             nvarchar(160) NULL,
  PasswordHash      nvarchar(400) NOT NULL,
  -- 'user' = inspector at one abattoir, 'admin' = regional manager for one
  -- province, 'super' = national. Capture and approval are never the same
  -- person, which is why these are layers and not flags on one role.
  Role              varchar(10)   NOT NULL,
  ScopeOrgId        int           NULL,      -- set for 'user'
  ScopeProvince     nvarchar(40)  NULL,      -- set for 'admin'
  IsActive          bit           NOT NULL CONSTRAINT DF_AppUser_Active DEFAULT (1),
  MustChangePassword bit          NOT NULL CONSTRAINT DF_AppUser_MustChange DEFAULT (1),
  FailedAttempts    int           NOT NULL CONSTRAINT DF_AppUser_Failed DEFAULT (0),
  LockedUntil       datetime2(0)  NULL,
  LegacyUsrId       int           NULL,      -- NAHDIS_FSA..Users.Id, for attribution
  CreatedAt         datetime2(0)  NOT NULL CONSTRAINT DF_AppUser_Created DEFAULT (SYSUTCDATETIME()),
  CreatedBy         nvarchar(64)  NULL,
  LastLoginAt       datetime2(0)  NULL,
  CONSTRAINT CK_AppUser_Role CHECK (Role IN ('user','admin','super')),
  -- The scope must match the layer. An admin with an abattoir scope, or a user
  -- with none, is a permission bug waiting to happen; the database refuses it.
  CONSTRAINT CK_AppUser_Scope CHECK (
        (Role = 'user'  AND ScopeOrgId IS NOT NULL AND ScopeProvince IS NULL)
     OR (Role = 'admin' AND ScopeOrgId IS NULL     AND ScopeProvince IS NOT NULL)
     OR (Role = 'super' AND ScopeOrgId IS NULL     AND ScopeProvince IS NULL)
  )
)`],

  /* Sessions live in the database rather than only in a signed cookie, so that
   * access can actually be revoked - a super user removing an account must end
   * that person's session, not wait for a cookie to expire. */
  [`arms.Session`, `
IF OBJECT_ID('arms.Session') IS NULL
CREATE TABLE arms.Session (
  SessionId   int IDENTITY(1,1) PRIMARY KEY,
  TokenHash   char(64)     NOT NULL UNIQUE,   -- SHA-256 of the cookie value
  UserId      int          NOT NULL REFERENCES arms.AppUser(UserId),
  CreatedAt   datetime2(0) NOT NULL CONSTRAINT DF_Session_Created DEFAULT (SYSUTCDATETIME()),
  ExpiresAt   datetime2(0) NOT NULL,
  LastSeenAt  datetime2(0) NULL,
  RevokedAt   datetime2(0) NULL,
  IpAddress   nvarchar(64) NULL,
  UserAgent   nvarchar(300) NULL
)`],

  [`arms.Session index`, `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Session_User')
CREATE INDEX IX_Session_User ON arms.Session (UserId, ExpiresAt)`],

  /* "Assume audit from the start. Who saw what matters less than who CHANGED
   * what, but a disease investigation may ask both." */
  [`arms.AuditLog`, `
IF OBJECT_ID('arms.AuditLog') IS NULL
CREATE TABLE arms.AuditLog (
  AuditId    bigint IDENTITY(1,1) PRIMARY KEY,
  At         datetime2(0) NOT NULL CONSTRAINT DF_Audit_At DEFAULT (SYSUTCDATETIME()),
  UserId     int          NULL,
  Username   nvarchar(64) NULL,
  Action     varchar(40)  NOT NULL,
  EntityType varchar(30)  NULL,
  EntityId   nvarchar(60) NULL,
  Detail     nvarchar(max) NULL,
  IpAddress  nvarchar(64) NULL
)`],

  [`arms.AuditLog index`, `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Audit_At')
CREATE INDEX IX_Audit_At ON arms.AuditLog (At DESC)`],

  /* Returns are looked up constantly by abattoir and month once capture is
   * live, and the recovered database has only the clustered primary key. */
  [`FormData lookup index`, `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FormData_Org_Period')
CREATE INDEX IX_FormData_Org_Period ON dbo.FormData (ORG_ID, FRMD_StartDate) INCLUDE (FRMD_Status, FRMD_Revision)`],

  [`FormDataItems lookup index`, `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FormDataItems_Return')
CREATE INDEX IX_FormDataItems_Return ON dbo.FormDataItems (FRMD_ID)`],

  [`FormDataItemParts lookup index`, `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_FormDataItemParts_Item')
CREATE INDEX IX_FormDataItemParts_Item ON dbo.FormDataItemParts (FDI_ID)`],
];

/* ---------------------------------------------------------------------------
 * THE LEGACY NOTIFICATION TRIGGER.
 *
 * dbo.FormData carries trig_FormData_CheckNotifiableDeseases, written in 2016.
 * It fires AFTER UPDATE, notices a return becoming Approved, and builds a
 * controlled-disease notification which it sends through sp_SendMail.
 *
 * It also writes three-part names out literally - `NAHDIS_FSA..regions`,
 * `NAHDIS_FSA..Organisation` - and that is the whole problem. Those names do
 * not follow DB_REGISTRY. On a machine where some other database happens to be
 * called NAHDIS_FSA the trigger binds to it silently and notifies against the
 * wrong register; where the login cannot reach it, every approval fails with
 * "not able to access the database". Neither is a state to leave a national
 * animal-health system in by accident.
 *
 * So this is a decision, not a workaround, and it is made in .env:
 *   leave    (default) the trigger stays exactly as it is. Correct when the
 *            databases are restored under their original names and the mail
 *            path is wanted. Approvals will FAIL if it cannot resolve.
 *   disable  the trigger is disabled on this copy and ARMS approvals work.
 *            Controlled-disease notification is then NOT sent by the database
 *            and ARMS does not yet send it either - that is a real gap and is
 *            reported every time this runs, not buried.
 *
 * Re-enabling is one statement: ALTER TABLE dbo.FormData ENABLE TRIGGER ALL.
 * ------------------------------------------------------------------------- */
async function handleLegacyTrigger(log) {
  const rows = await query(`
SELECT t.name AS name, t.is_disabled AS disabled
FROM ${D()}.sys.triggers t
JOIN ${D()}.sys.objects o ON o.object_id = t.parent_id
WHERE o.name = 'FormData'`);

  if (!rows.length) return;

  for (const t of rows) {
    const enabled = !t.disabled;
    if (config.arms.legacyNotifyTrigger === 'disable') {
      if (enabled) {
        await query(`DISABLE TRIGGER dbo.[${t.name}] ON dbo.FormData`);
        log(`    DISABLED legacy trigger ${t.name} (LEGACY_NOTIFY_TRIGGER=disable)`);
      } else {
        log(`    legacy trigger ${t.name} already disabled`);
      }
      log('    NOTE: controlled-disease notification is now sent by nothing.');
      log('          ARMS does not yet send it. This is a known gap, not a fix.');
    } else if (enabled) {
      log(`    legacy trigger ${t.name} is ENABLED and left alone (LEGACY_NOTIFY_TRIGGER=leave)`);
      log(`          It hardcodes NAHDIS_FSA..regions. If ${config.databases.registry} is not`);
      log('          called NAHDIS_FSA, approvals will fail or notify against the wrong register.');
    }
  }
}

export async function migrate({ log = console.log } = {}) {
  log('  migrating the data database...');

  const widened = await widenItemColumn();
  log(widened.changed
    ? `    FDI_Item widened from varchar(${widened.from}) to varchar(100) — PRRS is 52 characters`
    : `    FDI_Item already wide enough (${widened.from === -1 ? 'max' : widened.from})`);

  for (const [label, sql] of STATEMENTS) {
    await query(sql);
    log(`    ok  ${label}`);
  }

  await handleLegacyTrigger(log);

  log('  migration complete');
}
