/* Load a NAHDIS export into ARMS's Postgres.
 *
 *   node pgload.cjs guard  <dir>              refuse if the load would lose work done in ARMS
 *   node pgload.cjs script <dir> <out.psql>   write a one-transaction psql load script
 *
 * <dir> holds one <Schema>.<Table>.tsv per table (Postgres COPY text format:
 * tab-separated, backslash escapes, \N for NULL, a header row) and the
 * export's manifest.tsv. Connection from PGHOST/PGUSER/PGPASSWORD/PGDATABASE;
 * 'pg' is found through NODE_PATH (the app's own node_modules).
 *
 * .cjs because the app's package.json says "type": "module" and this is
 * CommonJS; the extension stops node guessing.
 */
const fs = require('fs');
const path = require('path');

const [mode, dir, out] = process.argv.slice(2);
const EXPECTED_TABLES = 33;
const BYTEA = new Set(['nahdis_fsa.users.securitystamp']);

/* File names carry SQL Server's spelling (Schedule8Data.FormData.tsv);
 * Postgres names are lower case. Key everything on the lower-case form. */
const files = new Map(
  fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tsv') && f.toLowerCase() !== 'manifest.tsv')
    .map((f) => [f.replace(/\.tsv$/, '').toLowerCase(), f])
);
if (files.size !== EXPECTED_TABLES) {
  throw new Error(`expected ${EXPECTED_TABLES} tables in ${dir}, found ${files.size}`);
}

const fileOf = (key) => {
  const f = files.get(key);
  if (!f) throw new Error(`the export has no ${key}`);
  return path.join(dir, f);
};
const header = (file) => fs.readFileSync(file, 'utf8').split('\n', 1)[0].split('\t').map((c) => c.toLowerCase());
const rows = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(1).filter((l) => l.length);

async function guard() {
  const { Client } = require('pg');
  const pg = new Client();
  await pg.connect();
  const file = fileOf('schedule8data.formdata');
  const h = header(file);
  const iId = h.indexOf('frmd_id');
  const iSt = h.indexOf('frmd_status');
  const src = new Map(rows(file).map((l) => { const c = l.split('\t'); return [Number(c[iId]), c[iSt]]; }));
  const { rows: tgt } = await pg.query('SELECT frmd_id, frmd_status FROM schedule8data.formdata');
  await pg.end();

  /* A return captured in ARMS exists only here; one ARMS approved is
   * Approved here and not there. Replacing the tables would undo either. */
  const lost = tgt.filter((r) => !src.has(Number(r.frmd_id)));
  const unapproved = tgt.filter((r) => r.frmd_status === 'Approved'
    && src.has(Number(r.frmd_id)) && src.get(Number(r.frmd_id)) !== 'Approved');

  console.log(`ARMS ${tgt.length} returns, export ${src.size}; only in ARMS: ${lost.length}; ` +
              `approved in ARMS but not in the export: ${unapproved.length}`);
  for (const r of [...lost, ...unapproved].slice(0, 20)) console.log(`  ${r.frmd_id} ${r.frmd_status}`);
  if (src.size < 10000) {
    console.log(`REFUSING: the export carries only ${src.size} returns - a partial export, not the record`);
    process.exit(2);
  }
  if (lost.length || unapproved.length) {
    console.log('REFUSING: the load would lose work done in ARMS');
    process.exit(2);
  }
  console.log('guard ok');
}

function script() {
  let s = '\\set ON_ERROR_STOP on\nBEGIN;\n';
  let returns = 0;
  for (const [key] of [...files].sort()) {
    const [schema, table] = key.split('.');
    let file = fileOf(key);
    const cols = header(file);

    /* bytea in COPY text format is \\x<hex>; the export writes bare hex. */
    const by = cols.map((c, i) => (BYTEA.has(`${schema}.${table}.${c}`) ? i : -1)).filter((i) => i >= 0);
    if (by.length) {
      const fixed = fs.readFileSync(file, 'utf8').split('\n').map((l, n) => {
        if (n === 0 || !l) return l;
        const c = l.split('\t');
        for (const i of by) if (c[i] !== '\\N') c[i] = '\\\\x' + c[i];
        return c.join('\t');
      }).join('\n');
      file += '.bytea';
      fs.writeFileSync(file, fixed);
    }

    const n = rows(file).length;
    if (key === 'schedule8data.formdata') returns = n;
    const p = file.split(path.sep).join('/');
    s += `DELETE FROM ${schema}.${table};\n`;
    s += `\\copy ${schema}.${table} (${cols.join(',')}) FROM '${p}' WITH (FORMAT text, HEADER true)\n`;
    s += `DO $$ BEGIN IF (SELECT COUNT(*) FROM ${schema}.${table}) <> ${n} THEN ` +
         `RAISE EXCEPTION '${schema}.${table}: count mismatch'; END IF; END $$;\n`;
  }
  /* New returns captured in ARMS number on from the highest id loaded. */
  for (const [t, c] of [['schedule8data.formdata', 'frmd_id'],
    ['schedule8data.formdataitems', 'fdi_id'], ['schedule8data.formdataitemparts', 'dip_id']]) {
    s += `SELECT setval(pg_get_serial_sequence('${t}', '${c}'), ` +
         `GREATEST(1, (SELECT COALESCE(MAX(${c}), 0) FROM ${t})));\n`;
  }
  s += 'COMMIT;\n';
  fs.writeFileSync(out, s);
  console.log(`wrote ${out}: ${files.size} tables, ${returns} returns`);
}

(mode === 'guard' ? guard() : Promise.resolve().then(script))
  .catch((e) => { console.error(e.message); process.exit(1); });
