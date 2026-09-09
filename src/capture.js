/* Writing a Schedule 8 return.
 *
 * THE LIFECYCLE, and it is the specification's, not ours:
 *
 *   InProgress ──submit──▶ Submitted ──approve──▶ Approved
 *        ▲                     │                     │
 *        └──── send back ──────┘                     │
 *                                                    │
 *   Approved ──revise──▶ new revision, InProgress ───┘
 *                        and the old row becomes Superseded
 *
 * "Every input is approved by the REGIONAL MANAGER before it becomes part of
 * the database." Nothing an inspector captures counts until that approval, so
 * a submitted return is held in a pending state and is not written into the
 * counted record on submission. ARMS counts only FRMD_Status='Approved', and
 * every reporting query in this codebase already filters on exactly that - so
 * the status column IS the mechanism, and nothing new was invented for it.
 *
 * CAPTURE AND APPROVAL ARE NEVER THE SAME PERSON. Enforced below, in
 * approveReturn, and it is the one rule here with teeth: in the recovered
 * record 4 396 of 5 024 approved returns appear captured and approved by the
 * same name. That is the finding this system exists to end.
 *
 * NOTHING IS EVER DELETED, ONLY SUPERSEDED. A correction does not overwrite an
 * approved return - it creates the next revision beside it and marks the old
 * one Superseded. The counted record stays exactly one row per abattoir-month
 * because only 'Approved' counts, and the history stays complete because
 * nothing was removed to achieve that.
 */
import { sql, query, raw, withTransaction, D } from './db.js';
import { config } from './config.js';
import { validateReturn, PERIOD_RE, periodStart, periodEnd } from './validate-return.js';

export const STATUS = {
  IN_PROGRESS: 'InProgress',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  /* Exactly ten characters, which is what FRMD_Status varchar(10) allows.
   * Convenient, and checked at startup rather than trusted. */
  SUPERSEDED: 'Superseded',
};

if (STATUS.SUPERSEDED.length > 10) throw new Error('FRMD_Status is varchar(10)');

/* ---------------------------------------------------------------------------
 * The form, indexed for writing.
 *
 * A row in FormDataItems carries the parent group id and name, the sub-group
 * id and name, and the item id - all of which live in the Schedule8 form
 * definition. Resolving them from the database rather than hardcoding means a
 * disease added to the form is writable the moment it is added.
 * ------------------------------------------------------------------------- */
let formIndex = null;

export async function loadFormIndex({ force = false } = {}) {
  if (formIndex && !force) return formIndex;

  const rows = await query(`
SELECT parent.GRP_ID AS ParentId, parent.GRP_Name AS ParentName,
       g.GRP_ID AS SubId, g.GRP_Name AS SubName,
       i.ITM_ID AS ItemId, i.ITM_Name AS ItemName,
       CASE WHEN i.ITM_Notify = 1 THEN 1 ELSE 0 END AS Notify
FROM ${D.forms('Groups')} g
JOIN ${D.forms('Groups')} parent ON parent.GRP_ID = g.GRP_ParentId
LEFT JOIN ${D.forms('Items')} i ON i.GRP_ID = g.GRP_ID AND i.ITM_Active = 1
WHERE g.FRM_ID = ${config.arms.formId} AND g.GRP_Active = 1`);

  const parts = await query(
    `SELECT PRT_ID, PRT_Name FROM ${D.forms('Parts')} WHERE PRT_Type = 'Body' ORDER BY PRT_ID`
  );
  const species = await query(`SELECT SPC_Name FROM ${D.registry('Species')} ORDER BY SPC_ID`);

  /* Keyed on parent+sub+item, case-insensitively. Inspectors and importers do
   * not agree on capitalisation, and the same discipline is applied in the
   * reporting path - see the indexer in explorer-data.js. */
  const byKey = new Map();
  const subByName = new Map();
  const notifiable = new Set();

  for (const r of rows) {
    const sub = {
      parentId: Number(r.ParentId),
      parentName: String(r.ParentName),
      subId: Number(r.SubId),
      subName: String(r.SubName || ''),
    };
    subByName.set(`${sub.parentName}|${sub.subName}`.toLowerCase(), sub);

    if (r.ItemName) {
      byKey.set(`${sub.parentName}|${sub.subName}|${r.ItemName}`.toLowerCase(), {
        ...sub, itemId: Number(r.ItemId), itemName: String(r.ItemName), notify: Number(r.Notify) === 1,
      });
      /* An item is notifiable by its name wherever it appears - the phone app
       * asks the same question the same way. */
      if (Number(r.Notify) === 1) notifiable.add(String(r.ItemName).toLowerCase());
    }
  }

  const organIds = new Map();
  for (const p of parts) organIds.set(String(p.PRT_Name).toLowerCase(), Number(p.PRT_ID));

  formIndex = {
    byKey,
    subByName,
    organIds,
    organs: parts.map((p) => String(p.PRT_Name)),
    species: species.map((s) => String(s.SPC_Name)),
    isNotifiable: (name) => notifiable.has(String(name || '').toLowerCase()),
    lookupItem: (parentName, subName, itemName) =>
      byKey.get(`${parentName}|${subName}|${itemName}`.toLowerCase()) || null,
    lookupSub: (parentName, subName) =>
      subByName.get(`${parentName}|${subName}`.toLowerCase()) || null,
  };
  return formIndex;
}

export function clearFormIndex() { formIndex = null; }

/* ---------------------------------------------------------------------------
 * Reading returns
 * ------------------------------------------------------------------------- */

function shapeReturn(r) {
  return {
    frmdId: Number(r.FRMD_Id),
    orgId: Number(r.ORG_ID),
    orgName: r.ORG_Name,
    status: r.FRMD_Status,
    revision: Number(r.FRMD_Revision),
    period: String(r.Period),
    capturedBy: r.FRMD_UserName,
    capturedByUserId: Number(r.USR_ID),
    approvedBy: r.FRMD_AprrovedUserName || null,
    approvedDate: r.FRMD_ApprovedDate || null,
    notes: r.FRMD_FormNotes || '',
    noSlaughter: Boolean(r.FRMD_NoSlaughter),
    noSlaughterReason: r.FRMD_NoSlaughterReason || '',
  };
}

/* The column list, optionally qualified with a table alias.
 *
 * Built by naming the columns rather than by splitting a string on commas -
 * DATE_FORMAT(FRMD_StartDate, '%Y-%m') contains two commas of its own, and
 * splitting on them produced `f.120) AS Period`, which SQL Server reported as
 * "Incorrect syntax near '.120'". */
function returnCols(alias = '') {
  const a = alias ? `${alias}.` : '';
  return [
    `${a}FRMD_Id`, `${a}ORG_ID`, `${a}ORG_Name`, `${a}FRMD_Status`, `${a}FRMD_Revision`,
    `DATE_FORMAT(${a}FRMD_StartDate, '%Y-%m') AS Period`,
    `${a}FRMD_UserName`, `${a}USR_ID`, `${a}FRMD_AprrovedUserName`, `${a}FRMD_ApprovedDate`,
    `${a}FRMD_FormNotes`, `${a}FRMD_NoSlaughter`, `${a}FRMD_NoSlaughterReason`,
  ].join(', ');
}

const RETURN_COLS = returnCols();

export async function getReturn(frmdId) {
  /* /returns/notanumber put Number('notanumber') - NaN - into the query, and a
   * NaN reaches MySQL as the bare word NaN, which it reads as a column name:
   * "Unknown column 'NaN' in 'where clause'". That is a 500 where the honest
   * answer is 404. Nothing hostile ever got through - Number() admits only a
   * number or NaN - but an id that is not a whole positive number is not an
   * id, and saying so here answers for every caller at once: the page route,
   * and approve, send-back and revise, which all load through this and already
   * treat a missing return properly. */
  const id = Number(frmdId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const rows = await sql`SELECT ${raw(RETURN_COLS)} FROM FormData WHERE FRMD_Id = ${id}`;
  return rows.length ? shapeReturn(rows[0]) : null;
}

/* The live return for an abattoir-month: the one that is not superseded. */
export async function findReturn(orgId, period) {
  const rows = await sql`
SELECT ${raw(RETURN_COLS)}
FROM FormData
WHERE ORG_ID = ${Number(orgId)}
  AND DATE_FORMAT(FRMD_StartDate, '%Y-%m') = ${period}
  AND FRMD_Status <> ${STATUS.SUPERSEDED}
ORDER BY FRMD_Revision DESC`;
  return rows.length ? shapeReturn(rows[0]) : null;
}

export async function returnHistory(orgId, period) {
  const rows = await sql`
SELECT ${raw(RETURN_COLS)}
FROM FormData
WHERE ORG_ID = ${Number(orgId)}
  AND DATE_FORMAT(FRMD_StartDate, '%Y-%m') = ${period}
ORDER BY FRMD_Revision DESC, FRMD_Id DESC`;
  return rows.map(shapeReturn);
}

/* Everything a person may act on, scoped. `orgIds === null` means national.
 *
 * The scope is a list of integers taken from the register, not from the
 * request, so it goes into the text as numbers; status and period come from
 * the caller and are bound. `-1` for an empty scope returns nothing, which is
 * the right answer for an account whose province holds no abattoirs - never
 * "everything". */
export async function listReturns({ orgIds, status = null, period = null, limit = 300 }) {
  const scope = orgIds === null
    ? ''
    : `AND f.ORG_ID IN (${orgIds.length ? orgIds.map((n) => Number(n) || -1).join(',') : '-1'})`;

  return (await sql`
SELECT ${raw(returnCols('f'))}
FROM FormData f
WHERE f.FRMD_Status <> ${STATUS.SUPERSEDED}
  ${raw(scope)}
  AND (${status === null ? raw('1=1') : raw('f.FRMD_Status = ')}${status === null ? raw('') : status})
  AND (${period === null ? raw('1=1') : raw("DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') = ")}${period === null ? raw('') : period})
ORDER BY f.FRMD_StartDate DESC, f.ORG_Name
                  LIMIT ${Number(limit)}`).map(shapeReturn);
}

/* How many, without fetching them. A badge that reads "50" because the query
 * asked for fifty rows is not a count, it is the limit - and a manager reading
 * it as "fifty waiting" would be wrong every time there were more. */
export async function countReturns({ orgIds, status = null }) {
  const scope = orgIds === null
    ? ''
    : `AND f.ORG_ID IN (${orgIds.length ? orgIds.map((n) => Number(n) || -1).join(',') : '-1'})`;

  const [r] = await sql`
SELECT COUNT(*) AS n
FROM FormData f
WHERE f.FRMD_Status <> ${STATUS.SUPERSEDED}
  ${raw(scope)}
  AND (${status === null ? raw('1=1') : raw('f.FRMD_Status = ')}${status === null ? raw('') : status})`;
  return Number(r.n);
}

/* Who has NOT submitted for a month — the regional manager's actual job.
 * "Sees who has and has not submitted, month by month, and chases the gaps."
 * An abattoir with no return shows as missing, never as a zero: it has not
 * reported nil, it has not reported. */
export async function missingReturns({ orgIds, period }) {
  const scope = orgIds === null
    ? ''
    : `AND o.ORG_ID IN (${orgIds.length ? orgIds.map((n) => Number(n) || -1).join(',') : '-1'})`;

  return sql`
SELECT o.ORG_ID, o.ORG_Name, LTRIM(RTRIM(IFNULL(a.ABA_RegistrationNumber,''))) AS RC
FROM ${raw(D.registry('Organisation'))} o
JOIN ${raw(D.registry('AbattoirMaster'))} a ON a.ORG_ID = o.ORG_ID
WHERE o.ORG_Active = 1
  ${raw(scope)}
  AND NOT EXISTS (
    SELECT 1 FROM FormData f
     WHERE f.ORG_ID = o.ORG_ID
       AND DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') = ${period}
       AND f.FRMD_Status <> ${STATUS.SUPERSEDED})
ORDER BY o.ORG_Name`;
}

/* The captured detail of one return, in the phone app's payload shape - so the
 * capture desk, the phone app and the API all speak one language. */
export async function getReturnItems(frmdId) {
  const items = await sql`
SELECT FDI_Id, GRP_Id, GRP_Name, GRP_subID, GRP_subNAme, ITM_ID, FDI_Item, FDI_Specie, FDI_Value, FDI_Notes
FROM FormDataItems WHERE FRMD_ID = ${Number(frmdId)} ORDER BY FDI_Id`;

  if (!items.length) return [];

  const parts = await sql`
SELECT p.FDI_ID, p.DIP_Name, p.DIP_Value
FROM FormDataItemParts p
JOIN FormDataItems i ON i.FDI_Id = p.FDI_ID
WHERE i.FRMD_ID = ${Number(frmdId)}
ORDER BY p.DIP_ID`;

  const byItem = new Map();
  for (const p of parts) {
    const k = Number(p.FDI_ID);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push({ part: String(p.DIP_Name), value: Number(p.DIP_Value) });
  }

  return items.map((i) => ({
    group: String(i.GRP_Name),
    subGroup: String(i.GRP_subNAme || ''),
    item: String(i.FDI_Item || ''),
    specie: String(i.FDI_Specie || ''),
    value: i.FDI_Value === null ? '' : String(i.FDI_Value),
    notes: i.FDI_Notes || '',
    parts: byItem.get(Number(i.FDI_Id)) || undefined,
  }));
}

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------- */

async function orgName(orgId) {
  const rows = await sql`SELECT ORG_Name FROM ${raw(D.registry('Organisation'))} WHERE ORG_ID = ${Number(orgId)}`;
  if (!rows.length) throw new Error(`abattoir ${orgId} is not on the register`);
  /* ORG_Name on FormData is varchar(50); the register's is the same width, so
   * this cannot truncate - but say so rather than assume it. */
  return String(rows[0].ORG_Name).slice(0, 50);
}

/* Write the items of a return. Always called inside a transaction, always
 * after clearing what was there: a save replaces the working copy of a draft
 * rather than accumulating duplicates. Approved rows are never touched by
 * this - a correction goes through reviseReturn and gets its own FRMD_Id. */
async function writeItems(t, frmdId, usrId, payload, form) {
  await t.sql`DELETE p FROM FormDataItemParts p
              JOIN FormDataItems i ON i.FDI_Id = p.FDI_ID
              WHERE i.FRMD_ID = ${Number(frmdId)}`;
  await t.sql`DELETE FROM FormDataItems WHERE FRMD_ID = ${Number(frmdId)}`;

  if (payload.noSlaughter) return { items: 0, parts: 0 };

  let nItems = 0;
  let nParts = 0;

  for (const it of payload.items || []) {
    const group = String(it.group || '');
    const sub = String(it.subGroup || '');
    const name = String(it.item || '');

    const resolved = name
      ? form.lookupItem(group, sub, name)
      : form.lookupSub(group, sub);

    if (!resolved) {
      /* Refuse rather than invent. An item the form does not define would be
       * written with a guessed group id and would then be counted under the
       * wrong heading - or not at all. */
      throw new Error(
        `"${name || sub}" is not on the Schedule 8 form under ${group}${sub ? ` › ${sub}` : ''}. ` +
        `The form definition is read from ${config.databases.forms}; add it there rather than here.`
      );
    }

    /* The offal container row carries value 0 and the organ counts live one
     * table down. That is how all 97 369 existing offal rows are stored, and
     * changing it would break eleven years of comparison. */
    const isOffal = group === 'OFFAL CONDEMNATIONS';
    const value = isOffal ? '0' : String(it.value ?? '').trim();

    const { insertId } = await t.run`
INSERT INTO FormDataItems
  (GRP_Id, GRP_Name, GRP_subID, GRP_subNAme, ITM_ID, FDI_Item, FDI_Specie, FDI_Value, FDI_Notes, FDI_Status, FRMD_ID, USR_ID)
VALUES (${resolved.parentId}, ${resolved.parentName}, ${resolved.subId}, ${resolved.subName},
        ${resolved.itemId ?? 0}, ${(resolved.itemName || name).slice(0, 100)},
        ${String(it.specie || '').slice(0, 10)}, ${value.slice(0, 10)},
        ${it.notes ? String(it.notes) : null}, '1', ${Number(frmdId)}, ${Number(usrId)})`;

    nItems++;
    const fdiId = Number(insertId);

    for (const p of it.parts || []) {
      const organ = String(p.part);
      const prtId = form.organIds.get(organ.toLowerCase());
      if (prtId === undefined) {
        throw new Error(`"${organ}" is not an organ on the Schedule 8 form.`);
      }
      await t.sql`
INSERT INTO FormDataItemParts (FDI_ID, DIP_Name, DIP_Value, PRT_ID)
VALUES (${fdiId}, ${organ.slice(0, 50)}, ${Math.round(Number(p.value) || 0)}, ${prtId})`;
      nParts++;
    }
  }

  return { items: nItems, parts: nParts };
}

/* Save a draft. Creates the return if this abattoir-month has none, otherwise
 * replaces the working copy. An approved return is never edited in place. */
export async function saveDraft({ payload, user, submit = false }) {
  const form = await loadFormIndex();

  const check = validateReturn(payload, form);
  /* A draft may be saved while still wrong - an inspector should be able to
   * stop halfway. Submitting may not. */
  if (submit && !check.ok) {
    const err = new Error('This return cannot be submitted yet.');
    err.validation = check;
    throw err;
  }

  const orgId = Number(payload?.abattoir?.orgId);
  const period = String(payload?.period?.month || '');
  if (!PERIOD_RE.test(period)) throw new Error('A valid month is required, as YYYY-MM.');

  const existing = await findReturn(orgId, period);

  if (existing && existing.status === STATUS.APPROVED) {
    throw new Error(
      `The ${period} return for this abattoir is already approved. ` +
      `Corrections are made as a new revision, which keeps the approved one beside it.`
    );
  }

  const name = await orgName(orgId);
  const inspector = String(payload.inspector || user.fullName).slice(0, 100);
  const status = submit ? STATUS.SUBMITTED : STATUS.IN_PROGRESS;

  return withTransaction(async (t) => {
    let frmdId = existing?.frmdId ?? null;
    let revision = existing?.revision ?? 1;

    if (frmdId === null) {
      const { insertId } = await t.run`
INSERT INTO FormData
  (FRM_ID, FRMD_Revision, ORG_ID, ORG_Name, FRMD_Status, FRMD_StartDate, FRMD_EndDate,
   USR_ID, FRMD_UserName, FRMD_FormNotes, FRMD_NoSlaughter, FRMD_NoSlaughterReason)
VALUES (${config.arms.formId}, 1, ${orgId}, ${name}, ${status},
        ${periodStart(period)}, ${periodEnd(period)},
        ${Number(user.legacyUsrId ?? user.userId)}, ${inspector},
        ${payload.notes || null}, ${payload.noSlaughter ? 1 : 0},
        ${payload.noSlaughterReason || null})`;
      frmdId = Number(insertId);
    } else {
      await t.sql`
UPDATE FormData
   SET FRMD_Status = ${status}, ORG_Name = ${name},
       USR_ID = ${Number(user.legacyUsrId ?? user.userId)}, FRMD_UserName = ${inspector},
       FRMD_FormNotes = ${payload.notes || null},
       FRMD_NoSlaughter = ${payload.noSlaughter ? 1 : 0},
       FRMD_NoSlaughterReason = ${payload.noSlaughterReason || null}
 WHERE FRMD_Id = ${frmdId}`;
    }

    const counts = await writeItems(t, frmdId, Number(user.legacyUsrId ?? user.userId), payload, form);
    return { frmdId, revision, status, created: existing === null, counts, validation: check };
  });
}

/* ---------------------------------------------------------------------------
 * Approval — the step that makes a figure count
 * ------------------------------------------------------------------------- */

export class SamePersonError extends Error {}

export async function approveReturn({ frmdId, user }) {
  const ret = await getReturn(frmdId);
  if (!ret) throw new Error('That return no longer exists.');

  if (ret.status !== STATUS.SUBMITTED) {
    throw new Error(
      ret.status === STATUS.APPROVED
        ? 'That return is already approved.'
        : `Only a submitted return can be approved. This one is ${ret.status}.`
    );
  }

  /* CAPTURE AND APPROVAL ARE NEVER THE SAME PERSON.
   *
   * Checked on the account, not on the typed name: in the recovered record the
   * approver was stored as free text and 4 396 of 5 024 approved returns carry
   * a name matching the capturer's. A name test would be a formality. The
   * account that captured cannot be the account that approves, and the name is
   * compared as well so that one person with two accounts is still caught. */
  const sameAccount = Number(ret.capturedByUserId) === Number(user.legacyUsrId ?? user.userId);
  const sameName = String(ret.capturedBy || '').trim().toLowerCase()
                === String(user.fullName || '').trim().toLowerCase();

  if (sameAccount || sameName) {
    throw new SamePersonError(
      'You captured this return, so you cannot approve it. Approval is what makes a figure ' +
      'count, and it has to be a second pair of eyes — another regional manager or a super user.'
    );
  }

  /* "Never let an approval be written without both." Both are set in the same
   * statement, and the WHERE re-checks the status so two managers clicking at
   * once cannot both approve. */
  return withTransaction(async (t) => {
    /* The affected-row count, not a returned row.
     *
     * MySQL reports rows CHANGED rather than rows matched, which is exactly
     * what is wanted here: the WHERE re-checks FRMD_Status, so of two managers
     * approving at once the first changes one row and the second changes none.
     * A count of anything other than 1 means somebody got there first. */
    const done = await t.run`
UPDATE FormData
   SET FRMD_Status = ${STATUS.APPROVED},
       FRMD_AprrovedUserName = ${String(user.fullName).slice(0, 100)},
       FRMD_ApprovedDate = NOW()
 WHERE FRMD_Id = ${Number(frmdId)} AND FRMD_Status = ${STATUS.SUBMITTED}`;

    if (done.affectedRows !== 1) {
      throw new Error('That return was changed by somebody else a moment ago. Reload and look again.');
    }

    /* If this was a correction, the revision it replaces steps aside NOW -
     * inside the same transaction. The counted record therefore holds exactly
     * one approved row for this abattoir-month at every instant: never two,
     * and never, in between, none. */
    if (ret.revision > 1) {
      await t.sql`
UPDATE FormData
   SET FRMD_Status = ${STATUS.SUPERSEDED}
 WHERE ORG_ID = ${Number(ret.orgId)}
   AND DATE_FORMAT(FRMD_StartDate, '%Y-%m') = ${ret.period}
   AND FRMD_Id <> ${Number(frmdId)}
   AND FRMD_Status = ${STATUS.APPROVED}`;
    }

    return true;
  }).then(() => getReturn(frmdId));
}

/* Sent back to the inspector, with a reason. Not a rejection in the database -
 * the return simply becomes a draft again and keeps its figures. */
export async function sendBack({ frmdId, user, reason }) {
  const ret = await getReturn(frmdId);
  if (!ret) throw new Error('That return no longer exists.');
  if (ret.status !== STATUS.SUBMITTED) throw new Error(`Only a submitted return can be sent back. This one is ${ret.status}.`);
  if (!String(reason || '').trim()) throw new Error('Say why it is going back — the inspector has to know what to fix.');

  const stamp = `[sent back by ${user.fullName} on ${new Date().toISOString().slice(0, 10)}] ${String(reason).trim()}`;
  await sql`
UPDATE FormData
   SET FRMD_Status = ${STATUS.IN_PROGRESS},
       FRMD_FormNotes = CASE WHEN FRMD_FormNotes IS NULL OR CAST(FRMD_FormNotes AS CHAR) = ''
                             THEN ${stamp}
                             ELSE CAST(FRMD_FormNotes AS CHAR) + CHAR(10) + ${stamp} END
 WHERE FRMD_Id = ${Number(frmdId)} AND FRMD_Status = ${STATUS.SUBMITTED}`;

  return getReturn(frmdId);
}

/* ---------------------------------------------------------------------------
 * Correcting an approved return
 *
 * NOTHING IS EVER DELETED, ONLY SUPERSEDED. This opens revision n+1 as a draft
 * carrying a copy of the figures. The approved row is left exactly as it is and
 * is only marked Superseded when the new revision is itself approved - so the
 * counted record is never, at any instant, missing that abattoir-month.
 * ------------------------------------------------------------------------- */
export async function reviseReturn({ frmdId, user, reason }) {
  const ret = await getReturn(frmdId);
  if (!ret) throw new Error('That return no longer exists.');
  if (ret.status !== STATUS.APPROVED) throw new Error('Only an approved return needs a revision; edit the draft instead.');
  if (!String(reason || '').trim()) throw new Error('A correction needs a reason. It becomes part of the record.');

  const items = await getReturnItems(frmdId);
  const form = await loadFormIndex();
  const stamp = `[revision ${ret.revision + 1} opened by ${user.fullName} on ${new Date().toISOString().slice(0, 10)}] ${String(reason).trim()}`;

  return withTransaction(async (t) => {
    const { insertId } = await t.run`
INSERT INTO FormData
  (FRM_ID, FRMD_Revision, ORG_ID, ORG_Name, FRMD_Status, FRMD_StartDate, FRMD_EndDate,
   USR_ID, FRMD_UserName, FRMD_FormNotes, FRMD_NoSlaughter, FRMD_NoSlaughterReason)
VALUES (${config.arms.formId}, ${ret.revision + 1}, ${ret.orgId}, ${ret.orgName},
        ${STATUS.IN_PROGRESS}, ${periodStart(ret.period)}, ${periodEnd(ret.period)},
        ${Number(user.legacyUsrId ?? user.userId)}, ${String(user.fullName).slice(0, 100)},
        ${`${ret.notes ? `${ret.notes}\n` : ''}${stamp}`},
        ${ret.noSlaughter ? 1 : 0}, ${ret.noSlaughterReason || null})`;

    const newId = Number(insertId);
    await writeItems(t, newId, Number(user.legacyUsrId ?? user.userId), {
      noSlaughter: ret.noSlaughter, items,
    }, form);

    return { frmdId: newId, revision: ret.revision + 1, supersedes: frmdId };
  });
}
