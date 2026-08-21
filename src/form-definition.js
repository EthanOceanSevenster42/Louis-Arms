/* The Schedule 8 form definition and the abattoir list, read from SQL.
 *
 * These are the values the phone app currently carries as literal arrays -
 * SPECIES, ORGANS, WC, PC, OFFAL, LAIR and ABATTOIRS, about 150 lines of them.
 * They were transcribed out of the Schedule8 database by hand, and they have
 * been frozen ever since: a disease added to the register, an abattoir newly
 * registered or renamed, an organ added to the form, none of it reaches the
 * inspector without somebody editing the HTML and redistributing the file.
 *
 * Everything below comes out of the Forms/Groups/Items/Parts tables and the
 * register instead. The app's own code is not touched; the server replaces the
 * block of literals as it serves the page.
 */
import { query, D } from './db.js';
import { config } from './config.js';

/* Sub-groups of CONDEMNATION STATISTICS, in the order the form declares. The
 * kilogram sub-group is pulled out separately - see below. */
async function condemnationGroups() {
  const rows = await query(`
SELECT g.GRP_ID, g.GRP_Name, g.GRP_Order,
       i.ITM_ID, i.ITM_Name, i.ITM_Order,
       CASE WHEN i.ITM_Notify = 1 THEN 1 ELSE 0 END AS Notify
FROM ${D.forms('Groups')} g
JOIN ${D.forms('Groups')} parent ON parent.GRP_ID = g.GRP_ParentId
LEFT JOIN ${D.forms('Items')} i ON i.GRP_ID = g.GRP_ID AND i.ITM_Active = 1
WHERE g.FRM_ID = ${config.arms.formId}
  AND g.GRP_Active = 1
  AND parent.GRP_Name = 'CONDEMNATION STATISTICS'
ORDER BY g.GRP_Order, i.ITM_Order`);

  const byGroup = new Map();
  for (const r of rows) {
    const id = Number(r.GRP_ID);
    if (!byGroup.has(id)) {
      byGroup.set(id, {
        id,
        /* `g` is what the inspector reads, `db` is the sub-group string as it is
         * stored. The app kept the two apart because somebody had typed a
         * prettier label with an ampersand; taking both from the database is
         * what stops the export string drifting away from the table it has to
         * join to, which was the point of keeping them separate. */
        g: String(r.GRP_Name || ''),
        db: String(r.GRP_Name || ''),
        notify: false,
        items: [],
      });
    }
    const grp = byGroup.get(id);
    if (r.ITM_Name) {
      grp.items.push(String(r.ITM_Name));
      if (Number(r.Notify) === 1) grp.notify = true;
    }
  }
  return [...byGroup.values()];
}

async function itemsOfGroup(parentName, groupName) {
  const clause = groupName === null
    ? ''
    : `AND g.GRP_Name = '${groupName.replace(/'/g, "''")}'`;

  const rows = await query(`
SELECT i.ITM_Name
FROM ${D.forms('Groups')} g
JOIN ${D.forms('Groups')} parent ON parent.GRP_ID = g.GRP_ParentId
JOIN ${D.forms('Items')} i ON i.GRP_ID = g.GRP_ID AND i.ITM_Active = 1
WHERE g.FRM_ID = ${config.arms.formId}
  AND g.GRP_Active = 1
  AND parent.GRP_Name = '${parentName.replace(/'/g, "''")}'
  ${clause}
ORDER BY g.GRP_Order, i.ITM_Order`);

  return rows.map((r) => String(r.ITM_Name));
}

/* THE ABATTOIR LIST.
 *
 * The frozen list in the app is 118 plants. It is not reproducible from any one
 * flag in the register - 117 of the 118 are active, only 88 carry the FSA flag,
 * and 117 have filed an approved return since the start of 2025. It was a
 * snapshot of who was reporting on the day it was transcribed.
 *
 * So this does not try to reproduce that list. It states the rule instead:
 * on the register, active, and having filed an approved return inside the
 * window. The window is configurable, and the rule is returned with the data so
 * a screen can say what it is showing. An abattoir newly registered now appears
 * on the inspector's phone without anybody editing a file.
 *
 * The window is measured from the most recent return in the database, not from
 * today. Against a restored archive that ends in Jul 2026, "the last 18 months"
 * has to mean the last 18 months of data, or the list comes back empty.
 */
async function abattoirs() {
  const months = config.arms.abattoirWindowMonths;

  const rows = await query(`
DECLARE @latest date = (SELECT MAX(FRMD_StartDate) FROM ${D.data('FormData')} WHERE FRMD_Status='Approved');
DECLARE @cut date = DATEADD(month, -${months}, @latest);

SELECT o.ORG_ID,
       o.ORG_Name,
       LTRIM(RTRIM(ISNULL(a.ABA_RegistrationNumber,''))) AS RC,
       STUFF((SELECT ',' + v.SPC_Name
                FROM ${D.registry('vw_AbattoirSpecies')} v
               WHERE v.ORG_ID = o.ORG_ID
               ORDER BY v.SPC_Name
                 FOR XML PATH('')), 1, 1, '') AS Species
FROM ${D.registry('Organisation')} o
JOIN ${D.registry('AbattoirMaster')} a ON a.ORG_ID = o.ORG_ID
WHERE o.ORG_Active = 1
  AND EXISTS (SELECT 1 FROM ${D.data('FormData')} f
               WHERE f.ORG_ID = o.ORG_ID
                 AND f.FRMD_Status = 'Approved'
                 AND f.FRMD_StartDate >= @cut)
ORDER BY o.ORG_Name`);

  return {
    rule: `on the register, active, and with an approved return in the ${months} months to the latest return in the database`,
    windowMonths: months,
    list: rows.map((r) => [
      Number(r.ORG_ID),
      String(r.ORG_Name || ''),
      String(r.Species || ''),
    ]),
  };
}

export async function buildFormDefinition() {
  const started = Date.now();

  const [species, organs, wc, pc, offal, lair, aba, form] = await Promise.all([
    query(`SELECT SPC_Name FROM ${D.registry('Species')} ORDER BY SPC_ID`)
      .then((r) => r.map((x) => String(x.SPC_Name))),

    /* The organs an offal condemnation is broken down by. PRT_Type 'Body'
     * separates them from the carcass parts (Forequarter, Hindquarter), which
     * belong to a different question. */
    query(`SELECT PRT_Name FROM ${D.forms('Parts')} WHERE PRT_Type = 'Body' ORDER BY PRT_ID`)
      .then((r) => r.map((x) => String(x.PRT_Name))),

    condemnationGroups(),
    itemsOfGroup('CONDEMNATION STATISTICS', 'Partially Condemned Diseases'),
    itemsOfGroup('OFFAL CONDEMNATIONS', null),
    itemsOfGroup('LAIRAGE REPORT', null),
    abattoirs(),

    query(`SELECT FRM_ID, FRM_Name, FRM_Version FROM ${D.forms('Forms')} WHERE FRM_ID = ${config.arms.formId}`)
      .then((r) => r[0] || null),
  ]);

  /* CONDEMNATION STATISTICS is in HEAD except for "Partially Condemned
   * Diseases", which is in KILOGRAMS. Every kilogram value in the whole dataset
   * sits in that one sub-group. It is therefore taken out of the head-counted
   * groups here and carried on its own, exactly as the app does - mixing the
   * two produces a number that means nothing. */
  const wcHead = wc.filter((g) => g.db !== 'Partially Condemned Diseases');

  const def = {
    form: form
      ? { id: Number(form.FRM_ID), name: String(form.FRM_Name), version: Number(form.FRM_Version) }
      : null,
    species,
    organs,
    wc: wcHead.map(({ g, db, notify, items }) => (notify ? { g, db, notify, items } : { g, db, items })),
    pc,
    offal,
    lair,
    abattoirs: aba.list,
    abattoirRule: aba.rule,
    units: {
      wc: 'head',
      pc: 'kilograms',
      offal: 'organs',
      lair: 'animals',
      note: 'These four are never added together, here or anywhere downstream.',
    },
    source: {
      server: config.sql.server,
      databases: { forms: config.databases.forms, registry: config.databases.registry, data: config.databases.data },
      live: true,
      generatedAt: new Date().toISOString(),
      buildMs: Date.now() - started,
    },
  };

  /* Guards. A form definition that has quietly lost a group would produce a
   * capture screen missing a whole class of condemnation, and the inspector
   * would have nowhere to record it. */
  const problems = [];
  if (def.species.length === 0) problems.push('no species');
  if (def.organs.length === 0) problems.push('no organs');
  if (def.wc.length === 0) problems.push('no carcass condemnation groups');
  if (def.pc.length === 0) problems.push('no partially-condemned list');
  if (def.offal.length === 0) problems.push('no offal condition list');
  if (def.lair.length === 0) problems.push('no lairage list');
  if (def.abattoirs.length === 0) problems.push('no abattoirs matched the reporting window');
  if (problems.length) {
    throw new Error(
      `The Schedule 8 form definition came back incomplete (${problems.join('; ')}). ` +
      `Check DB_FORMS=${config.databases.forms} and DB_REGISTRY=${config.databases.registry}.`
    );
  }

  return def;
}

let cache = { def: null, at: 0, building: null };

export async function getFormDefinition({ force = false } = {}) {
  const ttl = config.arms.cacheTtlMs;
  if (cache.def && !force && ttl > 0 && (Date.now() - cache.at) < ttl) return cache.def;
  if (cache.building) return cache.building;

  cache.building = buildFormDefinition()
    .then((d) => { cache = { def: d, at: Date.now(), building: null }; return d; })
    .catch((e) => { cache.building = null; throw e; });

  return cache.building;
}

export function clearFormCache() {
  cache = { def: null, at: 0, building: null };
}
