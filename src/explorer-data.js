/* Build the explorer's data payload live from SQL Server.
 *
 * This is a port of `2 - How it is built\extract-data.ps1`. The shape of what it
 * produces is not ours to invent - the explorer template reads it - so the
 * structure, the index order and the field names match that script exactly.
 * What changes is only where it runs: the PowerShell script writes a JSON file
 * that gets frozen into a 2,4 MB HTML file at build time, and this reads the
 * same figures out of the database on request.
 *
 * WHAT IS DELIBERATELY KEPT APART
 *   Five separate fact sets, never merged, because they are five different units:
 *     sl  slaughtered             head
 *     wc  whole carcass condemned head
 *     pc  partially condemned     KILOGRAMS
 *     of  offal condemned         ORGANS   (from FormDataItemParts - the table
 *                                           the old reports never joined to)
 *     lr  lairage losses          animals  (NOT a disease; the old system
 *                                           reported these as one, which is
 *                                           why they are split)
 *   Only FRMD_Status = 'Approved' is counted, matching every original report.
 */
import { query, D, db, tryDecimal } from './db.js';
import { config } from './config.js';
import { loadDiseaseMap, makeCanonicaliser } from './disease-map.js';
/* The RC province/type maps live in rc.js because an admin user's authority is
 * scoped by exactly the same derivation. The report and the permission must
 * never be able to disagree about which province a plant is in. */
import { RC_PROV, RC_TYPE } from './rc.js';


/* Small integer dimension tables, built as we go, so the fact rows can carry
 * indexes instead of repeating strings sixty thousand times.
 *
 * KEYS ARE COMPARED WITHOUT REGARD TO CASE, and the first spelling seen is the
 * one kept. The PowerShell extractor uses a hashtable here, and a PowerShell
 * hashtable is case-insensitive, so "Dead on arrival" and "Dead on Arrival"
 * are one entry there and were two here until this was matched - which split
 * one condition's count across two rows and inflated the disease list from 164
 * names to 178.
 *
 * Which spelling wins therefore depends on which row SQL Server returns first,
 * so every query that feeds this is given an explicit ORDER BY. Without one the
 * answer is stable only by luck, and a national disease list that changes its
 * spellings between two runs of the same query is not evidence. */
function indexer({ caseInsensitive = true } = {}) {
  const list = [];
  const map = new Map();
  const fn = (key) => {
    const raw = key == null ? '' : String(key);
    const k = caseInsensitive ? raw.toLowerCase() : raw;
    if (map.has(k)) return map.get(k);
    const i = list.length;
    list.push(raw);          // keep the spelling as first seen
    map.set(k, i);
    return i;
  };
  fn.list = list;
  return fn;
}

function registerSql(fromYear) {
  const org = D.registry('Organisation');
  const aba = D.registry('AbattoirMaster');
  const reg = D.registry('Regions');
  const formData = D.data('FormData');
  /* SQL Server had a scalar function NAHDIS_FSA.dbo.GetProvince(REG_ID) whose
   * body lives inside the .bak and did not come across with the data. Rather
   * than guess at it in a way that would be silently wrong, the expression is
   * configurable: set ARMS_PROVINCE_EXPR once the original is transcribed.
   * The default reads the region name, which is close but not authoritative -
   * this feeds the explorer's Prov facet only. Access scope does NOT use it;
   * that comes from AppUser.ScopeProvince and the RC number, in scope.js. */
  const provinceExpr = config.arms.provinceExpr;

  return `
SELECT o.ORG_ID,
       o.ORG_Name AS Nm,
       LTRIM(RTRIM(a.ABA_RegistrationNumber)) AS RC,
       TRIM(IFNULL(NULLIF(${provinceExpr},''),'Unknown')) AS Prov,
       IFNULL(NULLIF(LTRIM(RTRIM(a.ABA_TPCategory)),''),'Unknown') AS TP,
       CASE WHEN o.ORG_AFS = 1 THEN 1 ELSE 0 END AS Afs,
       CASE WHEN o.ORG_Active = 1 THEN 1 ELSE 0 END AS Act,
       IFNULL(NULLIF(LTRIM(RTRIM(o.ORG_ContactPersonName)),''),'') AS Owner,
       IFNULL(NULLIF(LTRIM(RTRIM(o.ORG_ContactNumber)),''),'') AS Tel,
       (SELECT MIN(DATE_FORMAT(f.FRMD_StartDate, '%Y-%m')) FROM ${formData} f
          WHERE f.ORG_ID=o.ORG_ID AND f.FRMD_Status='Approved') AS FirstRet,
       (SELECT MAX(DATE_FORMAT(f.FRMD_StartDate, '%Y-%m')) FROM ${formData} f
          WHERE f.ORG_ID=o.ORG_ID AND f.FRMD_Status='Approved') AS LastRet,
       CASE WHEN EXISTS (SELECT 1 FROM ${formData} f
                         WHERE f.ORG_ID = o.ORG_ID AND f.FRMD_Status = 'Approved'
                           AND YEAR(f.FRMD_StartDate) >= ${fromYear})
            THEN 1 ELSE 0 END AS Rep
FROM ${aba} a
JOIN ${org} o ON o.ORG_ID = a.ORG_ID
LEFT JOIN ${reg} r ON r.REG_ID = o.REG_ID
ORDER BY o.ORG_ID`;
}

/* MySQL has no TRY_CONVERT, and a plain CAST does not throw here - it quietly
 * returns 0, which would turn an unreadable figure into a real-looking zero.
 * tryDecimal() guards the cast with a numeric test so a bad value becomes
 * NULL, and the Bad counters below go on counting them exactly as before. */
function factQueries(fromYear) {
  const f = D.data('FormData');
  const i = D.data('FormDataItems');
  const p = D.data('FormDataItemParts');
  const approved = `f.FRMD_Status='Approved' AND YEAR(f.FRMD_StartDate) >= ${fromYear}`;
  const val = tryDecimal('i.FDI_Value');

  return {
    sl: {
      label: 'slaughtered (head)',
      sql: `
SELECT DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') AS Y, f.ORG_ID, i.FDI_Specie AS Sp, '' AS It, '' AS Og,
       SUM(${val}) AS V,
       SUM(CASE WHEN ${val} IS NULL THEN 1 ELSE 0 END) AS Bad
FROM ${f} f JOIN ${i} i ON i.FRMD_ID = f.FRMD_Id
WHERE ${approved} AND i.GRP_subID = 6
GROUP BY DATE_FORMAT(f.FRMD_StartDate, '%Y-%m'), f.ORG_ID, i.FDI_Specie
ORDER BY 1, 2, 3`,
    },
    wc: {
      label: 'whole carcass condemned (head)',
      sql: `
SELECT DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') AS Y, f.ORG_ID, i.FDI_Specie AS Sp, i.FDI_Item AS It, '' AS Og,
       SUM(${val}) AS V,
       SUM(CASE WHEN ${val} IS NULL THEN 1 ELSE 0 END) AS Bad
FROM ${f} f JOIN ${i} i ON i.FRMD_ID = f.FRMD_Id
WHERE ${approved} AND i.GRP_Id = 1 AND i.GRP_subID <> 15
GROUP BY DATE_FORMAT(f.FRMD_StartDate, '%Y-%m'), f.ORG_ID, i.FDI_Specie, i.FDI_Item
HAVING SUM(${val}) > 0
ORDER BY 1, 2, 3, 4`,
    },
    pc: {
      label: 'partially condemned (kg)',
      sql: `
SELECT DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') AS Y, f.ORG_ID, i.FDI_Specie AS Sp, i.FDI_Item AS It, '' AS Og,
       SUM(${val}) AS V,
       SUM(CASE WHEN ${val} IS NULL THEN 1 ELSE 0 END) AS Bad
FROM ${f} f JOIN ${i} i ON i.FRMD_ID = f.FRMD_Id
WHERE ${approved} AND i.GRP_subID = 15
GROUP BY DATE_FORMAT(f.FRMD_StartDate, '%Y-%m'), f.ORG_ID, i.FDI_Specie, i.FDI_Item
HAVING SUM(${val}) > 0
ORDER BY 1, 2, 3, 4`,
    },
    of: {
      label: 'offal condemned (organs)',
      sql: `
SELECT DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') AS Y, f.ORG_ID, i.FDI_Specie AS Sp, i.FDI_Item AS It,
       p.DIP_Name AS Og, SUM(CAST(p.DIP_Value AS SIGNED)) AS V, 0 AS Bad
FROM ${f} f
JOIN ${i} i ON i.FRMD_ID = f.FRMD_Id
JOIN ${p} p ON p.FDI_ID = i.FDI_Id
WHERE ${approved}
GROUP BY DATE_FORMAT(f.FRMD_StartDate, '%Y-%m'), f.ORG_ID, i.FDI_Specie, i.FDI_Item, p.DIP_Name
HAVING SUM(CAST(p.DIP_Value AS SIGNED)) > 0
ORDER BY 1, 2, 3, 4, 5`,
    },
    lr: {
      label: 'lairage losses (animals)',
      sql: `
SELECT DATE_FORMAT(f.FRMD_StartDate, '%Y-%m') AS Y, f.ORG_ID, i.FDI_Specie AS Sp, i.FDI_Item AS It, '' AS Og,
       SUM(${val}) AS V,
       SUM(CASE WHEN ${val} IS NULL THEN 1 ELSE 0 END) AS Bad
FROM ${f} f JOIN ${i} i ON i.FRMD_ID = f.FRMD_Id
WHERE ${approved} AND i.GRP_Id = 2
GROUP BY DATE_FORMAT(f.FRMD_StartDate, '%Y-%m'), f.ORG_ID, i.FDI_Specie, i.FDI_Item
HAVING SUM(${val}) > 0
ORDER BY 1, 2, 3, 4`,
    },
  };
}

function round3(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

export async function buildExplorerPayload() {
  const started = Date.now();
  const fromYear = config.arms.fromYear;

  const map = loadDiseaseMap(config.paths.diseaseMap);
  const canon = makeCanonicaliser(map);

  const prov = indexer();
  const tp = indexer();
  const rcIx = indexer();
  const spec = indexer();
  const item = indexer();
  const organ = indexer();

  /* THE FRAME IS EVERY REGISTERED ABATTOIR IN THE COUNTRY, not only the ones
   * that report. An abattoir that has never submitted is not missing data - it
   * IS the finding, and a national system has to be able to show it. */
  console.log('  reading the national abattoir register, keyed on the RC number...');
  const regRows = await query(registerSql(fromYear));

  /* THE ABATTOIR IS ITS REGISTRATION CERTIFICATE NUMBER, NOT ITS NAME.
   * Names change, owners change, plants close and reopen under new names - and
   * in this register 41 records are the same plant twice, which splits eleven
   * years of history down the middle. Hluhluwe "stopped reporting" in Dec 2024
   * and Allen's Abattoir "started"; it is one abattoir, RC 5/41, renamed. */
  const groups = new Map();
  for (const row of regRows) {
    const rc = String(row.RC || '').trim() || `NO-RC-${row.ORG_ID}`;
    if (!groups.has(rc)) groups.set(rc, []);
    groups.get(rc).push(row);
  }

  const aba = [];
  const alias = [];
  const abaByOrg = new Map();
  const provClash = [];
  let reporting = 0;

  for (const rc of [...groups.keys()].sort()) {
    const recs = groups.get(rc);

    /* The plant's current name is the record that reported most recently;
     * failing that an active one; failing that the first. Never an arbitrary
     * pick - the name shown against eleven years of history matters. */
    let best = null;
    for (const x of recs) {
      if (best === null) { best = x; continue; }
      const xl = String(x.LastRet || '');
      const bl = String(best.LastRet || '');
      if (xl > bl) best = x;
      else if (xl === bl && Number(x.Act) > Number(best.Act)) best = x;
    }

    const d = rc.charAt(0);
    const provName = RC_PROV[d] !== undefined ? RC_PROV[d] : String(best.Prov || '');
    const regProv = String(best.Prov || '');
    if (RC_PROV[d] !== undefined && regProv !== 'Unknown' && regProv !== provName) {
      provClash.push(`${rc} ${best.Nm}: RC says ${provName}, register says ${regProv}`);
    }

    const lastCh = rc.charAt(rc.length - 1).toUpperCase();
    const typeName = RC_TYPE[lastCh] !== undefined ? RC_TYPE[lastCh] : String(best.TP || '');

    const pi = prov(provName);
    const ti = tp(typeName);
    const ri = rcIx(rc);
    const rep = recs.some((x) => Number(x.Rep) === 1) ? 1 : 0;

    // [name, province, type, FSA flag, active, reports, rcIndex]
    const ai = aba.length;
    aba.push([String(best.Nm || ''), pi, ti, Number(best.Afs), Number(best.Act), rep, ri]);

    // every name this RC has traded under: [name, orgId, active, first, last, owner, tel]
    const names = [];
    const sorted = [...recs].sort((a, b) => String(b.LastRet || '').localeCompare(String(a.LastRet || '')));
    for (const x of sorted) {
      names.push([
        String(x.Nm || ''), Number(x.ORG_ID), Number(x.Act),
        String(x.FirstRet || ''), String(x.LastRet || ''),
        String(x.Owner || ''), String(x.Tel || ''),
      ]);
      abaByOrg.set(Number(x.ORG_ID), ai);
    }
    alias.push(names);
    if (rep === 1) reporting++;
  }

  console.log(`    ${groups.size} registration certificates covering ${abaByOrg.size} register records`);
  console.log(`    ${reporting} of them reporting since ${fromYear}`);
  if (provClash.length) {
    console.log(`    province disagreements (RC wins): ${provClash.length}`);
    for (const c of provClash) console.log(`      ${c}`);
  }
  console.log(`    ${prov.list.length} provinces: ${prov.list.join(', ')}`);

  /* Guards kept from the build script. A collapsed lookup produces a report
   * that looks plausible and is wrong, which is the failure this project can
   * least afford in front of a department. */
  if (prov.list.length < 2) {
    throw new Error('province lookup collapsed - refusing to build a national report with one province');
  }
  if (aba.length < 600) {
    throw new Error(`only ${aba.length} certificates in the register - expected the full national list`);
  }

  /* Periods are 'YYYY-MM' strings. They sort correctly as text, so no date
   * parsing is needed anywhere downstream. */
  const periodIx = indexer();
  const fact = {};
  let badTotal = 0;
  let offRegister = 0;

  console.log(`  ARMS starts at ${fromYear} - earlier years are excluded, not deleted`);
  const facts = factQueries(fromYear);

  for (const key of ['sl', 'wc', 'pc', 'of', 'lr']) {
    console.log(`  reading ${facts[key].label}...`);
    const rows = [];
    for (const r of await query(facts[key].sql)) {
      if (r.V === null || r.V === undefined) continue;

      const ai = abaByOrg.get(Number(r.ORG_ID));
      if (ai === undefined) { offRegister++; continue; }   // not on the register

      const rec = [periodIx(String(r.Y)), ai, spec(r.Sp)];
      if (key !== 'sl') rec.push(item(canon(r.It)));
      if (key === 'of') rec.push(organ(r.Og));
      rec.push(round3(r.V));                                // whole numbers stay
      rows.push(rec);                                       // whole; kg keep 3dp

      if (r.Bad !== null && r.Bad !== undefined) badTotal += Number(r.Bad);
    }
    fact[key] = rows;
    console.log(`    ${rows.length} rows`);
  }

  /* The submission log: who filed what, and how far it got. Deliberately NOT
   * limited to Approved. A return sitting at InProgress is the most useful
   * thing on the page for a manager chasing submissions - it says somebody
   * started and stopped, which is different from never starting.
   * 1 = in progress, 2 = submitted and awaiting approval, 3 = approved. */
  console.log('  reading the submission log (all statuses)...');
  const subSql = `
SELECT DATE_FORMAT(FRMD_StartDate, '%Y-%m') AS Y, ORG_ID,
       MAX(CASE FRMD_Status WHEN 'Approved' THEN 3 WHEN 'Submitted' THEN 2 ELSE 1 END) AS St,
       COUNT(*) AS N
FROM ${D.data('FormData')}
WHERE YEAR(FRMD_StartDate) >= ${fromYear}
GROUP BY DATE_FORMAT(FRMD_StartDate, '%Y-%m'), ORG_ID
ORDER BY 1, 2`;

  const subRows = [];
  for (const r of await query(subSql)) {
    const ai = abaByOrg.get(Number(r.ORG_ID));
    if (ai === undefined) continue;                          // not on the register
    subRows.push([periodIx(String(r.Y)), ai, Number(r.St)]);
  }
  fact.sub = subRows;
  console.log(`    ${subRows.length} abattoir-months with a return of any status`);

  /* Periods are discovered in query order; sort them and remap every fact row
   * so the explorer's period axis reads left to right. */
  const discovered = periodIx.list;
  const sortedPeriods = [...discovered].sort();
  const remap = new Map();
  sortedPeriods.forEach((p, i) => remap.set(discovered.indexOf(p), i));
  for (const key of Object.keys(fact)) {
    for (const row of fact[key]) row[0] = remap.get(row[0]);
  }

  const counts = await query(
    `SELECT COUNT(*) AS n FROM ${D.data('FormData')} ` +
    `WHERE FRMD_Status='Approved' AND YEAR(FRMD_StartDate) >= ${fromYear}`
  );

  const nameReport = canon.report();
  console.log(`  name map: ${nameReport.matched} of ${nameReport.total} rules matched something`);
  if (nameReport.unused.length) console.log(`    unused rules: ${nameReport.unused.join('; ')}`);
  if (offRegister) console.log(`  fact rows whose abattoir is not on the register (skipped): ${offRegister}`);

  const payload = {
    meta: {
      built: new Date().toISOString().slice(0, 10),
      returns: Number(counts[0].n),
      periods: sortedPeriods,
      unparsed: badTotal,
      registered: aba.length,
      records: abaByOrg.size,
      provClash,
      reporting,
      fromYear,
      /* Where the figures came from, stated on the payload itself. A screen
       * that cannot say which database it read is not evidence. */
      source: {
        server: config.sql.server,
        databases: { ...config.databases },
        live: true,
        generatedAt: new Date().toISOString(),
        buildMs: Date.now() - started,
      },
      note:
        `Every registered abattoir in the country is listed. Only those that have submitted an ` +
        `approved Schedule 8 since ${fromYear} carry figures; the rest are shown as not reporting, ` +
        `which is itself the finding. ARMS begins at ${fromYear} because the years before it were ` +
        `dominated by condemnations coded Other, with no diagnosis recorded - up to 86 percent in ` +
        `2016. Those returns still exist in the database and in the backups; they are excluded from ` +
        `this system, not deleted.`,
    },
    prov: prov.list,
    tp: tp.list,
    aba,
    spec: spec.list,
    item: item.list,
    organ: organ.list,
    rc: rcIx.list,
    alias,
    sl: fact.sl, wc: fact.wc, pc: fact.pc, of: fact.of, lr: fact.lr,
    sub: fact.sub,
  };

  console.log(`  payload built in ${Date.now() - started} ms`);
  return payload;
}

/* Cache. The aggregation is a few seconds of SQL over 150k rows and the answer
 * only changes when a return is approved, so it is held rather than rebuilt per
 * request. TTL comes from config; POST /api/refresh clears it on demand. */
let cache = { payload: null, at: 0, building: null };

export async function getExplorerPayload({ force = false } = {}) {
  const ttl = config.arms.cacheTtlMs;
  const fresh = cache.payload && !force && ttl > 0 && (Date.now() - cache.at) < ttl;
  if (fresh) return cache.payload;

  /* Two requests arriving together must not both run the aggregation. */
  if (cache.building) return cache.building;

  cache.building = buildExplorerPayload()
    .then((p) => { cache = { payload: p, at: Date.now(), building: null }; return p; })
    .catch((e) => { cache.building = null; throw e; });

  return cache.building;
}

export function cacheStatus() {
  return {
    cached: Boolean(cache.payload),
    ageMs: cache.payload ? Date.now() - cache.at : null,
    ttlMs: config.arms.cacheTtlMs,
  };
}

export function clearCache() {
  cache = { payload: null, at: 0, building: null };
}
