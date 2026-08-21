/* Preflight. Run `npm run check` before starting the server, or after moving it
 * to another machine, to find a misconfiguration on the command line instead of
 * on a page in front of somebody.
 *
 * It proves four things in order, and stops at the first that fails:
 *   1. the settings are complete and the files it needs are where it says
 *   2. SQL Server answers, with the three databases restored and readable
 *   3. the explorer payload builds, and its headline figures are sane
 *   4. the form definition builds, and no part of the form has gone missing
 */
import fs from 'node:fs';
import { config, validateConfig, baseUrl } from './config.js';
import { query, D, closePool } from './db.js';
import { buildExplorerPayload } from './explorer-data.js';
import { buildFormDefinition } from './form-definition.js';
import { renderExplorer, renderMobile } from './render.js';

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) ok(`${label}${detail ? ` — ${detail}` : ''}`);
  else { bad(`${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const n = (x) => Number(x).toLocaleString('en-ZA').replace(/,/g, ' ');

async function main() {
  console.log('\nARMS backend — preflight\n');

  console.log('1. settings');
  validateConfig();
  ok(`SQL ${config.sql.server}${config.sql.instance ? `\\${config.sql.instance}` : `:${config.sql.port}`} as ${config.sql.user}`);
  ok(`databases ${config.databases.data} / ${config.databases.registry} / ${config.databases.forms}`);
  ok(`ARMS starts at ${config.arms.fromYear}`);
  for (const [label, p] of Object.entries(config.paths)) {
    /* The built 2,4 MB explorer is the offline artefact and is NOT in the
     * repository - it has eleven years of figures and 529 telephone numbers
     * compiled into it. Its absence costs only /download/explorer, so it is
     * reported rather than failed. */
    if (label === 'explorerBuilt' && !fs.existsSync(p)) {
      console.log(`  note  ${label} not present — /download/explorer will say so. Not required.`);
      continue;
    }
    check(label, fs.existsSync(p), p);
  }

  console.log('\n2. database');
  const counts = (await query(`
SELECT (SELECT COUNT(*) FROM ${D.data('FormData')}) AS returns,
       (SELECT COUNT(*) FROM ${D.data('FormData')} WHERE FRMD_Status='Approved') AS approved,
       (SELECT COUNT(*) FROM ${D.data('FormDataItems')}) AS items,
       (SELECT COUNT(*) FROM ${D.data('FormDataItemParts')}) AS parts,
       (SELECT COUNT(*) FROM ${D.registry('AbattoirMaster')}) AS abattoirs,
       (SELECT COUNT(*) FROM ${D.forms('Items')}) AS formItems`))[0];
  ok(`returns ${n(counts.returns)} (${n(counts.approved)} approved)`);
  ok(`items ${n(counts.items)}, item parts ${n(counts.parts)}`);
  ok(`register ${n(counts.abattoirs)} abattoirs, form ${n(counts.formItems)} items`);

  /* The offal parts table is the whole point of the project: 97 369 container
   * rows whose organ counts live one table down, which no old report ever
   * joined to. A zero here means the wrong backup is restored. */
  check('offal detail present', Number(counts.parts) > 0,
    Number(counts.parts) === 0 ? 'FormDataItemParts is empty — this is where every organ count lives' : `${n(counts.parts)} rows`);

  console.log('\n3. explorer payload');
  const payload = await buildExplorerPayload();
  check('periods', payload.meta.periods.length > 0, `${payload.meta.periods.length} months, ${payload.meta.periods[0]} to ${payload.meta.periods.at(-1)}`);
  check('register carried', payload.aba.length >= 600, `${n(payload.aba.length)} certificates, ${payload.meta.reporting} reporting`);
  check('provinces', payload.prov.length >= 2, payload.prov.join(', '));
  check('offal facts', payload.of.length > 0, `${n(payload.of.length)} rows`);
  check('kilograms kept separate', payload.pc.length > 0, `${n(payload.pc.length)} rows in the kg sub-group`);
  check('lairage kept separate', payload.lr.length > 0, `${n(payload.lr.length)} rows`);

  /* The four measures are never added together. Report them apart, as the
   * system must. */
  const total = (rows) => rows.reduce((s, r) => s + r[r.length - 1], 0);
  console.log(`        slaughtered      ${n(total(payload.sl))} head`);
  console.log(`        whole carcasses  ${n(total(payload.wc))} head`);
  console.log(`        partially cond.  ${n(Math.round(total(payload.pc)))} kg`);
  console.log(`        offal            ${n(total(payload.of))} organs`);
  console.log(`        lairage          ${n(total(payload.lr))} animals`);
  if (payload.meta.unparsed) console.log(`        values that would not parse as numbers: ${payload.meta.unparsed}`);

  console.log('\n4. form definition');
  const def = await buildFormDefinition();
  check('species', def.species.length > 0, `${def.species.length}`);
  check('organs', def.organs.length > 0, def.organs.join(', '));
  check('carcass groups', def.wc.length > 0, def.wc.map((g) => `${g.db} (${g.items.length})`).join(', '));
  check('partially condemned', def.pc.length > 0, `${def.pc.length} conditions, in KILOGRAMS`);
  check('offal conditions', def.offal.length > 0, `${def.offal.length}`);
  check('lairage', def.lair.length > 0, def.lair.join(', '));
  check('abattoirs', def.abattoirs.length > 0, `${def.abattoirs.length} — ${def.abattoirRule}`);
  check('notifiable group flagged', def.wc.some((g) => g.notify),
    def.wc.filter((g) => g.notify).map((g) => g.db).join(', ') || 'none flagged ITM_Notify');

  console.log('\n5. rendering');
  const explorerHtml = await renderExplorer(config.paths.explorerTemplate, payload);
  check('explorer renders', explorerHtml.includes('/*__DATA__*/') && explorerHtml.length > 200000,
    `${Math.round(explorerHtml.length / 1024)} KB`);
  const mobileHtml = await renderMobile(config.paths.mobileApp, def);
  check('phone app renders', mobileHtml.includes('var ABATTOIRS'), `${Math.round(mobileHtml.length / 1024)} KB`);

  /* The app is strict ES5 — it has to run on old phones. The injected block is
   * generated, so check the generator has not introduced anything newer. */
  const injected = mobileHtml.slice(
    mobileHtml.indexOf('/* ---------- form definition'),
    mobileHtml.indexOf('/* ---------- storage')
  );
  const es6 = /\b(let|const)\s|=>|`/.test(injected);
  check('injected block is ES5', !es6, es6 ? 'found let/const/arrow/template literal' : 'no let, const, arrow or template literal');

  console.log(
    failures === 0
      ? `\nAll checks passed. Start with: npm start   →   ${baseUrl()}\n`
      : `\n${failures} check(s) failed.\n`
  );
  await closePool();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`\n  FAILED: ${err.message}\n`);
  await closePool().catch(() => {});
  process.exit(1);
});
