/* Removing what the end-to-end test wrote.
 *
 * verify-auth.js captures, submits and approves real returns, because that is
 * the only way to prove the write path actually works. An approved return is
 * counted in every figure ARMS reports, so leaving one behind would put
 * fabricated condemnation numbers into a national animal-health record. They
 * come out again.
 *
 * This is the ONLY thing in the codebase that deletes a return, and it is
 * deliberately narrow: it will not touch a return unless the test names its
 * exact FRMD_Id and that row was captured by one of the accounts the test
 * created. Everything else in ARMS supersedes rather than deletes.
 *
 * Run it on its own to clear strays from an interrupted test:
 *   node src/test-cleanup.js --prefix t.
 */
import { pathToFileURL } from 'node:url';
import { sql, query, withTransaction } from './db.js';
import { closePool } from './db.js';

export async function cleanupTestData({ usernames = [], frmdIds = [], prefix = null }) {
  const out = { returns: 0, items: 0, parts: 0, accounts: 0, kept: [] };

  /* Which accounts are in play. A prefix is allowed only because the test's own
   * accounts are named t.insp./t.mgr., and it is still resolved to a list of
   * real usernames before anything is removed. */
  let names = usernames.map((u) => String(u).toLowerCase());
  if (prefix) {
    const rows = await sql`SELECT Username, FullName FROM arms.AppUser WHERE Username LIKE ${`${prefix}%`}`;
    names = [...new Set([...names, ...rows.map((r) => String(r.Username).toLowerCase())])];
  }
  if (!names.length) return out;

  /* The names those accounts capture under. FormData records the person, not
   * the account id, so this is how a test return is recognised - and it is
   * why the account rows are read before anything is removed. */
  const captured = new Set();
  for (const n of names) {
    const rows = await sql`SELECT FullName FROM arms.AppUser WHERE Username = ${n}`;
    for (const r of rows) captured.add(String(r.FullName));
  }
  if (!captured.size) return out;

  await withTransaction(async (t) => {
    for (const id of frmdIds.map(Number).filter(Boolean)) {
      /* Refuse anything that is not demonstrably the test's own work. */
      const [row] = await t.sql`
SELECT FRMD_Id, FRMD_UserName, ORG_ID, FRMD_Status,
       DATE_FORMAT(FRMD_StartDate, '%Y-%m') AS Period
FROM FormData WHERE FRMD_Id = ${id}`;
      if (!row) continue;
      if (!captured.has(String(row.FRMD_UserName))) {
        out.kept.push(`${id} (captured by ${row.FRMD_UserName}, not a test account)`);
        continue;
      }

      /* Every revision of that abattoir-month written by a test account,
       * including the one this call superseded. */
      const family = await t.sql`
SELECT FRMD_Id, FRMD_UserName FROM FormData
WHERE ORG_ID = ${Number(row.ORG_ID)}
  AND DATE_FORMAT(FRMD_StartDate, '%Y-%m') = ${String(row.Period)}`;

      for (const f of family) {
        if (!captured.has(String(f.FRMD_UserName))) {
          out.kept.push(`${f.FRMD_Id} (captured by ${f.FRMD_UserName})`);
          continue;
        }
        const fid = Number(f.FRMD_Id);
        const [p] = await t.sql`
SELECT COUNT(*) AS n FROM FormDataItemParts p
JOIN FormDataItems i ON i.FDI_Id = p.FDI_ID WHERE i.FRMD_ID = ${fid}`;
        const [i] = await t.sql`SELECT COUNT(*) AS n FROM FormDataItems WHERE FRMD_ID = ${fid}`;

        await t.sql`DELETE p FROM FormDataItemParts p
                    JOIN FormDataItems i ON i.FDI_Id = p.FDI_ID WHERE i.FRMD_ID = ${fid}`;
        await t.sql`DELETE FROM FormDataItems WHERE FRMD_ID = ${fid}`;
        await t.sql`DELETE FROM FormData WHERE FRMD_Id = ${fid}`;

        out.parts += Number(p.n);
        out.items += Number(i.n);
        out.returns += 1;
      }
    }

    for (const n of names) {
      await t.sql`DELETE s FROM arms.Session s
                  JOIN arms.AppUser u ON u.UserId = s.UserId WHERE u.Username = ${n}`;
      const d = await t.run`DELETE FROM arms.AppUser WHERE Username = ${n}`;
      out.accounts += d.affectedRows;
    }
  });

  return out;
}

/* Run directly to clear strays. pathToFileURL rather than string-building the
 * URL: on Windows process.argv[1] is C:\... and a hand-made "file://" + path
 * comes out with two slashes where import.meta.url has three, so the block
 * silently never runs. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--prefix');
  const prefix = i > -1 ? process.argv[i + 1] : 't.';

  const accounts = await sql`SELECT Username, FullName FROM arms.AppUser WHERE Username LIKE ${`${prefix}%`}`;
  if (!accounts.length) {
    console.log(`\n  No accounts starting "${prefix}". Nothing to clear.\n`);
  } else {
    const names = accounts.map((a) => String(a.FullName));
    /* Every return captured under a test account's name. */
    const rows = await query(`
SELECT FRMD_Id FROM FormData
WHERE FRMD_UserName IN (${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',') || "''"})`);

    console.log(`\n  Clearing ${accounts.length} test account(s) and ${rows.length} return(s) they captured.\n`);
    const out = await cleanupTestData({
      usernames: accounts.map((a) => a.Username),
      frmdIds: rows.map((r) => Number(r.FRMD_Id)),
    });
    console.log(`  removed ${out.returns} returns, ${out.items} items, ${out.parts} organ rows, ${out.accounts} accounts`);
    for (const k of out.kept) console.log(`  KEPT ${k}`);
    console.log('');
  }
  await closePool();
}
