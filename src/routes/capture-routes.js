/* The capture desk, and the approval queue.
 *
 * Recommendation 2 of `ARMS - Getting the data in.md`: "one keyboard-driven
 * screen for the FSA inspector receiving emailed paper, with the same
 * validation as the phone app. Not glamorous, but it is where the current cost
 * is, and it stops bad figures entering while somebody is still looking at the
 * source."
 *
 * The form posts ordinary fields - sl[Cattle], of[Cattle][Abscessations][Livers]
 * - which Express parses back into nested objects. That means the figures a
 * person has already entered survive without JavaScript; script only adds new
 * rows. An abattoir office is not the place to require a modern browser.
 */
import express from 'express';
import { requireAuth, requireApprover, clientIp } from '../auth/middleware.js';
import { scopedOrgIds, mayReachOrg, canApprove } from '../auth/users.js';
import { audit, ACTIONS } from '../audit.js';
import {
  STATUS, loadFormIndex, listReturns, missingReturns, findReturn, getReturn,
  getReturnItems, returnHistory, saveDraft, approveReturn, sendBack, reviseReturn,
} from '../capture.js';
import { validateReturn, PERIOD_RE, periodStart, periodEnd } from '../validate-return.js';
import { getFormDefinition } from '../form-definition.js';
import { page, esc, messages, problemList, csrfField, statusPill } from '../pages.js';

export const captureRoutes = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const monthName = (p) => {
  if (!PERIOD_RE.test(p)) return p;
  const [y, m] = p.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};

/* ---------------------------------------------------------------------------
 * The posted form -> the phone app's payload shape.
 *
 * One shape for both clients: whatever the phone app exports, the capture desk
 * produces, and the same validator judges. A figure left blank stays out of
 * the payload entirely - blank is not zero, and a blank that arrived as 0
 * would assert that somebody looked and found none.
 * ------------------------------------------------------------------------- */
function bodyToPayload(body, { orgId, orgName, period, inspector, form }) {
  const items = [];
  const keep = (v) => v !== undefined && String(v).trim() !== '';

  const sl = body.sl || {};
  const cp = body.cp || {};
  const wc = body.wc || {};
  const wcn = body.wcn || {};
  const pc = body.pc || {};
  const of_ = body.of || {};
  const lr = body.lr || {};

  const species = new Set([
    ...Object.keys(sl), ...Object.keys(cp), ...Object.keys(wc),
    ...Object.keys(pc), ...Object.keys(of_), ...Object.keys(lr),
  ]);

  for (const sp of species) {
    if (keep(sl[sp])) {
      items.push({ group: 'SLAUGHTERED', subGroup: 'Total Slaughtered', item: '', specie: sp, value: sl[sp], unit: 'head' });
    }
    if (keep(cp[sp])) {
      items.push({ group: 'SLAUGHTERED', subGroup: 'Conditionally Passed Carcases', item: 'Cysticercosis', specie: sp, value: cp[sp], unit: 'head' });
    }
    for (const [item, value] of Object.entries(wc[sp] || {})) {
      if (!keep(value)) continue;
      const found = form.wcSubGroupOf(item);
      items.push({
        group: 'CONDEMNATION STATISTICS', subGroup: found, item, specie: sp,
        value, unit: 'head', notes: (wcn[sp] || {})[item] || '',
      });
    }
    for (const [item, value] of Object.entries(pc[sp] || {})) {
      if (!keep(value)) continue;
      items.push({ group: 'CONDEMNATION STATISTICS', subGroup: 'Partially Condemned Diseases', item, specie: sp, value, unit: 'kg' });
    }
    for (const [item, organs] of Object.entries(of_[sp] || {})) {
      const parts = [];
      for (const [organ, value] of Object.entries(organs || {})) {
        /* An organ the inspector counted and found clean is a nil, and a nil
         * is a finding. It travels. Only organs never looked at are left out. */
        if (keep(value)) parts.push({ part: organ, value });
      }
      items.push({ group: 'OFFAL CONDEMNATIONS', subGroup: '', item, specie: sp, value: '0', unit: 'organs', parts });
    }
    for (const [item, value] of Object.entries(lr[sp] || {})) {
      if (!keep(value)) continue;
      items.push({ group: 'LAIRAGE REPORT', subGroup: 'NUMBER OF ANIMALS -', item, specie: sp, value, unit: 'head' });
    }
  }

  return {
    form: 'Schedule 8', formVersion: 2, source: 'ARMS capture desk',
    abattoir: { orgId, name: orgName },
    period: { month: period, start: periodStart(period), end: periodEnd(period) },
    inspector,
    capturedAt: new Date().toISOString(),
    noSlaughter: Boolean(body.noSlaughter),
    noSlaughterReason: body.noSlaughterReason || '',
    notes: body.notes || '',
    items: body.noSlaughter ? [] : items,
  };
}

/* The stored items, back into the shape the form renders from. */
function itemsToBlocks(items) {
  const b = {};
  const sp = (s) => (b[s] ||= { sl: '', cp: '', wc: {}, wcn: {}, pc: {}, of: {}, lr: {} });

  for (const it of items) {
    const s = sp(it.specie);
    if (it.group === 'SLAUGHTERED' && it.subGroup === 'Total Slaughtered') s.sl = it.value;
    else if (it.group === 'SLAUGHTERED') s.cp = it.value;
    else if (it.group === 'CONDEMNATION STATISTICS' && it.subGroup === 'Partially Condemned Diseases') s.pc[it.item] = it.value;
    else if (it.group === 'CONDEMNATION STATISTICS') { s.wc[it.item] = it.value; s.wcn[it.item] = it.notes || ''; }
    else if (it.group === 'OFFAL CONDEMNATIONS') {
      s.of[it.item] = {};
      for (const p of it.parts || []) s.of[it.item][p.part] = String(p.value);
    } else if (it.group === 'LAIRAGE REPORT') s.lr[it.item] = it.value;
  }
  return b;
}

/* ---------------------------------------------------------------------------
 * The list of returns
 * ------------------------------------------------------------------------- */

captureRoutes.get('/returns', requireAuth, wrap(async (req, res) => {
  const orgIds = await scopedOrgIds(req.user);
  const status = ['InProgress', 'Submitted', 'Approved'].includes(req.query.status) ? req.query.status : null;
  const rows = await listReturns({ orgIds, status, limit: 200 });

  res.type('html').send(page({
    title: 'Returns', user: req.user, active: '/returns',
    body: `
<h1>Returns</h1>
<p class="sub">${req.user.role === 'user'
  ? 'The monthly Schedule 8 for your abattoir.'
  : `Every return in your scope. Only <b>Approved</b> counts anywhere in ARMS.`}</p>

${messages({ ok: req.query.saved ? 'Saved.' : req.query.submitted ? 'Submitted. It now waits for a regional manager to approve it.' : null })}

<div class="row" style="margin:0 0 1rem">
  <a class="btn" href="/returns/new">Start a return</a>
  <a class="btn ghost" href="/returns">All</a>
  <a class="btn ghost" href="/returns?status=InProgress">Drafts</a>
  <a class="btn ghost" href="/returns?status=Submitted">Awaiting approval</a>
  <a class="btn ghost" href="/returns?status=Approved">Approved</a>
</div>

${rows.length === 0 ? '<div class="card"><span>No returns yet.</span></div>' : `
<div class="scroll"><table>
<tr><th>Month</th><th>Abattoir</th><th>Status</th><th>Rev</th><th>Captured by</th><th>Approved by</th><th></th></tr>
${rows.map((r) => `<tr>
  <td>${esc(monthName(r.period))}</td>
  <td>${esc(r.orgName)}</td>
  <td>${statusPill(r.status)}</td>
  <td class="n">${r.revision}</td>
  <td class="tiny muted">${esc(r.capturedBy || '—')}</td>
  <td class="tiny muted">${esc(r.approvedBy || '—')}</td>
  <td><a href="/returns/${r.frmdId}">${r.status === STATUS.APPROVED ? 'View' : 'Open'}</a></td>
</tr>`).join('')}
</table></div>`}`,
  }));
}));

/* ---------------------------------------------------------------------------
 * Starting one
 * ------------------------------------------------------------------------- */

captureRoutes.get('/returns/new', requireAuth, wrap(async (req, res) => {
  const def = await getFormDefinition();
  const orgIds = await scopedOrgIds(req.user);
  const choices = def.abattoirs
    .filter(([id]) => orgIds === null || orgIds.includes(Number(id)))
    .map(([id, name]) => ({ id, name }));

  const now = new Date();
  const months = [];
  for (let i = 0; i < 18; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  res.type('html').send(page({
    title: 'Start a return', user: req.user, active: '/returns',
    body: `
<h1>Start a return</h1>
<p class="sub">One Schedule 8 per abattoir per month.</p>
${messages({ bad: req.query.error || null })}

${choices.length === 0 ? `<div class="msg bad">No abattoir in your scope is currently reporting.
  A super user assigns which abattoir an inspector captures for.</div>` : `
<form method="get" action="/returns/open" class="card">
  <label for="orgId">Abattoir</label>
  <select id="orgId" name="orgId" required>
    ${choices.map((c) => `<option value="${c.id}"${
      req.user.scopeOrgId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
  </select>
  <label for="period">Month</label>
  <select id="period" name="period" required>
    ${months.map((m) => `<option value="${m}">${esc(monthName(m))}</option>`).join('')}
  </select>
  <div class="row"><button type="submit">Open</button>
    <a class="btn ghost" href="/returns">Cancel</a></div>
</form>`}`,
  }));
}));

/* Opens the existing return for that abattoir-month, or a blank one. Never
 * creates a row until something is saved. */
captureRoutes.get('/returns/open', requireAuth, wrap(async (req, res) => {
  const orgId = Number(req.query.orgId);
  const period = String(req.query.period || '');

  if (!PERIOD_RE.test(period)) return res.redirect('/returns/new?error=' + encodeURIComponent('Choose a valid month.'));
  if (!await mayReachOrg(req.user, orgId)) {
    return res.redirect('/returns/new?error=' + encodeURIComponent('That abattoir is outside your scope.'));
  }

  const existing = await findReturn(orgId, period);
  if (existing) return res.redirect(`/returns/${existing.frmdId}`);
  res.redirect(`/returns/draft?orgId=${orgId}&period=${period}`);
}));

/* ---------------------------------------------------------------------------
 * The capture desk itself
 * ------------------------------------------------------------------------- */

async function renderDesk(req, res, { ret, orgId, period, orgName, blocks, validation = null, notice = null }) {
  const def = await getFormDefinition();
  const readOnly = ret && (ret.status === STATUS.APPROVED || ret.status === STATUS.SUPERSEDED);

  const wcItems = def.wc.flatMap((g) => g.items.map((i) => ({ item: i, group: g.db, notify: Boolean(g.notify) })));
  const notifySet = new Set(wcItems.filter((x) => x.notify).map((x) => x.item));

  /* blocks carries the per-species figures plus a few __-prefixed fields for
   * the return as a whole (notes, the nil-return flag). Those are not species
   * and must not be rendered as one - doing so asked for b.wc on a string. */
  const speciesUsed = Object.keys(blocks).filter((k) => !k.startsWith('__'));

  const opts = (list, sel = '') => list.map((v) =>
    `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');

  const speciesBlock = (sp) => {
    const b = blocks[sp] || { sl: '', cp: '', wc: {}, wcn: {}, pc: {}, of: {}, lr: {} };
    const row = (label, name, value, extra = '') =>
      `<label>${esc(label)}</label><input name="${name}" value="${esc(value)}" inputmode="decimal" ${extra}>`;

    return `
<div class="card" data-species="${esc(sp)}">
  <b>${esc(sp)}</b>
  <div class="grid2">
    <div>${row('Total slaughtered (head)', `sl[${sp}]`, b.sl, readOnly ? 'readonly' : 'required')}</div>
    <div>${row('Conditionally passed — Cysticercosis (head)', `cp[${sp}]`, b.cp, readOnly ? 'readonly' : '')}</div>
  </div>

  <h2>Whole carcasses condemned — HEAD</h2>
  <div class="rows" data-kind="wc">
    ${Object.entries(b.wc).map(([item, v]) => `
    <div class="grid2" style="align-items:end">
      <div><label>Condition</label>
        <select name="wc-key" disabled><option>${esc(item)}</option></select>
        <input type="hidden" name="wc[${sp}][${item}]" value="${esc(v)}" class="hidden-val"></div>
      <div><label>Head${notifySet.has(item) ? ' — controlled disease, a note is required' : ''}</label>
        <input name="wc[${sp}][${item}]" value="${esc(v)}" inputmode="numeric" ${readOnly ? 'readonly' : ''}></div>
      ${notifySet.has(item) ? `<div style="grid-column:1/-1"><label>Note (date, case detail, who was told)</label>
        <input name="wcn[${sp}][${item}]" value="${esc(b.wcn[item] || '')}" ${readOnly ? 'readonly' : ''}></div>` : ''}
    </div>`).join('')}
  </div>
  ${readOnly ? '' : `<div class="row"><select data-add="wc" data-sp="${esc(sp)}">
    <option value="">Add a condition…</option>${opts(wcItems.map((x) => x.item))}</select></div>`}

  <h2>Partially condemned — KILOGRAMS</h2>
  <div class="rows" data-kind="pc">
    ${Object.entries(b.pc).map(([item, v]) => `
    <div class="grid2" style="align-items:end">
      <div><label>Condition</label><input value="${esc(item)}" readonly></div>
      <div><label>Kilograms</label><input name="pc[${sp}][${item}]" value="${esc(v)}" inputmode="decimal" ${readOnly ? 'readonly' : ''}></div>
    </div>`).join('')}
  </div>
  ${readOnly ? '' : `<div class="row"><select data-add="pc" data-sp="${esc(sp)}">
    <option value="">Add a condition…</option>${opts(def.pc)}</select></div>`}

  <h2>Offal condemned — ORGANS</h2>
  <div class="rows" data-kind="of">
    ${Object.entries(b.of).map(([item, organs]) => `
    <div class="card" style="margin:.4rem 0">
      <b class="tiny">${esc(item)}</b>
      <div class="grid2">
        ${def.organs.map((o) => `<div><label>${esc(o)}</label>
          <input name="of[${sp}][${item}][${o}]" value="${esc(organs[o] ?? '')}" inputmode="numeric" ${readOnly ? 'readonly' : ''}></div>`).join('')}
      </div>
      <p class="tiny muted">A blank organ was never looked at. A nil is a finding and travels.</p>
    </div>`).join('')}
  </div>
  ${readOnly ? '' : `<div class="row"><select data-add="of" data-sp="${esc(sp)}">
    <option value="">Add an offal condition…</option>${opts(def.offal)}</select></div>`}

  <h2>Lairage — ANIMALS LOST</h2>
  <div class="rows" data-kind="lr">
    ${Object.entries(b.lr).map(([item, v]) => `
    <div class="grid2" style="align-items:end">
      <div><label>Loss</label><input value="${esc(item)}" readonly></div>
      <div><label>Animals</label><input name="lr[${sp}][${item}]" value="${esc(v)}" inputmode="numeric" ${readOnly ? 'readonly' : ''}></div>
    </div>`).join('')}
  </div>
  ${readOnly ? '' : `<div class="row"><select data-add="lr" data-sp="${esc(sp)}">
    <option value="">Add a lairage loss…</option>${opts(def.lair)}</select></div>`}
</div>`;
  };

  const history = ret ? await returnHistory(ret.orgId, ret.period) : [];

  res.type('html').send(page({
    title: `${orgName} — ${monthName(period)}`, user: req.user, active: '/returns',
    body: `
<h1>${esc(orgName)}</h1>
<p class="sub">${esc(monthName(period))}
  ${ret ? `· ${statusPill(ret.status)} · revision ${ret.revision}` : '· not yet started'}</p>

${notice ? messages({ ok: notice }) : ''}
${validation ? problemList('This return cannot be submitted yet', validation.probs) : ''}
${validation ? problemList('Worth a look before submitting', validation.warns, 'warn') : ''}

${readOnly ? `<div class="msg ok">This return is ${esc(ret.status.toLowerCase())} and is not editable.
  ${ret.status === STATUS.APPROVED ? 'A correction is made as a new revision, which keeps this one beside it.' : ''}</div>
  ${ret.status === STATUS.APPROVED && canApprove(req.user) ? `
  <form method="post" action="/returns/${ret.frmdId}/revise" class="card">
    ${csrfField(req.csrfToken)}
    <label for="reason">Why does this need correcting? It becomes part of the record.</label>
    <input id="reason" name="reason" required>
    <div class="row"><button type="submit">Open revision ${ret.revision + 1}</button></div>
  </form>` : ''}` : ''}

<form method="post" action="${ret ? `/returns/${ret.frmdId}/save` : '/returns/save'}" id="desk">
  ${csrfField(req.csrfToken)}
  <input type="hidden" name="orgId" value="${orgId}">
  <input type="hidden" name="period" value="${esc(period)}">

  <div class="card">
    <label><input type="checkbox" name="noSlaughter" value="1" ${blocks.__noSlaughter ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>
      Nil return — nothing was slaughtered this month</label>
    <input name="noSlaughterReason" placeholder="Reason for the nil return"
           value="${esc(blocks.__noSlaughterReason || '')}" ${readOnly ? 'readonly' : ''}>
  </div>

  <div id="species">${speciesUsed.map(speciesBlock).join('')}</div>

  ${readOnly ? '' : `<div class="card">
    <label for="addsp">Add a species</label>
    <div class="row" style="margin:0">
      <select id="addsp" style="max-width:16rem">${opts(def.species)}</select>
      <button type="submit" name="addSpecies" value="1" class="ghost">Add</button>
    </div>
  </div>

  <div class="card">
    <label for="notes">Notes on this return</label>
    <textarea id="notes" name="notes" rows="3">${esc(blocks.__notes || '')}</textarea>
  </div>

  <div class="row">
    <button type="submit" name="action" value="save" class="ghost">Save draft</button>
    <button type="submit" name="action" value="submit">Submit for approval</button>
    <a class="btn ghost" href="/returns">Back</a>
  </div>`}
</form>

${history.length > 1 ? `<h2>Revisions</h2><div class="scroll"><table>
<tr><th>Rev</th><th>Status</th><th>Captured by</th><th>Approved by</th><th>When</th></tr>
${history.map((h) => `<tr><td class="n">${h.revision}</td><td>${statusPill(h.status)}</td>
  <td class="tiny">${esc(h.capturedBy || '—')}</td><td class="tiny">${esc(h.approvedBy || '—')}</td>
  <td class="tiny muted">${esc(h.approvedDate ? String(h.approvedDate).slice(0, 10) : '—')}</td></tr>`).join('')}
</table></div><p class="tiny muted">Nothing is ever deleted. A superseded revision stays in the
record with who changed it and when.</p>` : ''}

<script>
/* Adding a row is the only thing script does here. Everything already on the
   page is a plain form field and posts without it. */
(function(){
  var addSp = document.getElementById('addsp');
  document.addEventListener('change', function(e){
    var kind = e.target.getAttribute && e.target.getAttribute('data-add');
    if(!kind || !e.target.value) return;
    var sp = e.target.getAttribute('data-sp'), item = e.target.value;
    var box = e.target.closest('.card').querySelector('.rows[data-kind="'+kind+'"]');
    if(box.querySelector('[name*="['+item+']"]')){ e.target.value=''; return; }
    var d = document.createElement('div');
    if(kind==='of'){
      var organs = ${JSON.stringify(def.organs)};
      d.className='card'; d.style.margin='.4rem 0';
      d.innerHTML = '<b class="tiny">'+item+'</b><div class="grid2">'+organs.map(function(o){
        return '<div><label>'+o+'</label><input name="of['+sp+']['+item+']['+o+']" inputmode="numeric"></div>';
      }).join('')+'</div>';
    } else {
      var label = kind==='pc' ? 'Kilograms' : (kind==='lr' ? 'Animals' : 'Head');
      var notify = ${JSON.stringify([...notifySet])}.indexOf(item) >= 0;
      d.className='grid2'; d.style.alignItems='end';
      d.innerHTML = '<div><label>'+(kind==='lr'?'Loss':'Condition')+'</label><input value="'+item+'" readonly></div>'+
        '<div><label>'+label+'</label><input name="'+kind+'['+sp+']['+item+']" inputmode="decimal"></div>'+
        (notify ? '<div style="grid-column:1/-1"><label>Note (date, case detail, who was told)</label>'+
                  '<input name="wcn['+sp+']['+item+']"></div>' : '');
    }
    box.appendChild(d);
    e.target.value='';
  });
})();
</script>`,
  }));
}

/* A blank desk for an abattoir-month with no row yet. */
captureRoutes.get('/returns/draft', requireAuth, wrap(async (req, res) => {
  const orgId = Number(req.query.orgId);
  const period = String(req.query.period || '');
  if (!PERIOD_RE.test(period) || !await mayReachOrg(req.user, orgId)) return res.redirect('/returns/new');

  const def = await getFormDefinition();
  const found = def.abattoirs.find(([id]) => Number(id) === orgId);
  await renderDesk(req, res, {
    ret: null, orgId, period, orgName: found ? found[1] : `Abattoir ${orgId}`, blocks: {},
  });
}));

captureRoutes.get('/returns/:id', requireAuth, wrap(async (req, res, next) => {
  const ret = await getReturn(req.params.id);
  if (!ret) return next();
  if (!await mayReachOrg(req.user, ret.orgId)) {
    return res.status(403).type('html').send(page({
      title: 'Out of scope', user: req.user,
      body: `<h1>Out of scope</h1><p class="sub">That return belongs to an abattoir you do not cover.
      Condemnation detail is commercially sensitive, so it is not shown.</p>
      <p><a href="/returns">Back to returns</a></p>`,
    }));
  }

  const items = await getReturnItems(ret.frmdId);
  const blocks = itemsToBlocks(items);
  blocks.__notes = ret.notes;
  blocks.__noSlaughter = ret.noSlaughter;
  blocks.__noSlaughterReason = ret.noSlaughterReason;

  await renderDesk(req, res, {
    ret, orgId: ret.orgId, period: ret.period, orgName: ret.orgName, blocks,
  });
}));

/* ---------------------------------------------------------------------------
 * Saving and submitting
 * ------------------------------------------------------------------------- */

async function handleSave(req, res, ret) {
  const orgId = Number(ret ? ret.orgId : req.body.orgId);
  const period = String(ret ? ret.period : req.body.period || '');

  if (!await mayReachOrg(req.user, orgId)) {
    return res.status(403).send('That abattoir is outside your scope.');
  }

  const def = await getFormDefinition();
  const found = def.abattoirs.find(([id]) => Number(id) === orgId);
  const orgName = found ? found[1] : (ret?.orgName || `Abattoir ${orgId}`);

  const wcSubGroupOf = (item) => {
    for (const g of def.wc) if (g.items.includes(item)) return g.db;
    return 'Other';
  };

  const payload = bodyToPayload(req.body, {
    orgId, orgName, period, inspector: req.user.fullName, form: { wcSubGroupOf },
  });

  /* "Add a species" is a form submission too - it re-renders with one more
   * block rather than saving, so nothing is written by pressing Add. */
  if (req.body.addSpecies) {
    const blocks = itemsToBlocks(payload.items);
    const add = String(req.body.addsp || '').trim();
    if (add && !blocks[add]) blocks[add] = { sl: '', cp: '', wc: {}, wcn: {}, pc: {}, of: {}, lr: {} };
    blocks.__notes = payload.notes;
    blocks.__noSlaughter = payload.noSlaughter;
    blocks.__noSlaughterReason = payload.noSlaughterReason;
    return renderDesk(req, res, { ret, orgId, period, orgName, blocks });
  }

  const submit = req.body.action === 'submit';

  try {
    const result = await saveDraft({ payload, user: req.user, submit });
    await audit({
      user: req.user,
      action: submit ? ACTIONS.RETURN_SUBMITTED : ACTIONS.RETURN_SAVED,
      entityType: 'return', entityId: result.frmdId,
      detail: { orgId, period, items: result.counts.items, parts: result.counts.parts },
      ip: clientIp(req),
    });
    return res.redirect(`/returns/${result.frmdId}?${submit ? 'submitted=1' : 'saved=1'}`);
  } catch (err) {
    if (err.validation) {
      const blocks = itemsToBlocks(payload.items);
      blocks.__notes = payload.notes;
      blocks.__noSlaughter = payload.noSlaughter;
      blocks.__noSlaughterReason = payload.noSlaughterReason;
      return renderDesk(req, res, { ret, orgId, period, orgName, blocks, validation: err.validation });
    }
    throw err;
  }
}

captureRoutes.post('/returns/save', requireAuth, wrap((req, res) => handleSave(req, res, null)));

captureRoutes.post('/returns/:id/save', requireAuth, wrap(async (req, res, next) => {
  const ret = await getReturn(req.params.id);
  if (!ret) return next();
  return handleSave(req, res, ret);
}));

captureRoutes.post('/returns/:id/revise', requireAuth, requireApprover, wrap(async (req, res) => {
  const result = await reviseReturn({ frmdId: req.params.id, user: req.user, reason: req.body.reason });
  await audit({
    user: req.user, action: ACTIONS.RETURN_REVISED, entityType: 'return', entityId: result.frmdId,
    detail: { supersedes: result.supersedes, revision: result.revision, reason: req.body.reason }, ip: clientIp(req),
  });
  res.redirect(`/returns/${result.frmdId}`);
}));

/* ---------------------------------------------------------------------------
 * The approval queue — the step that makes a figure count
 * ------------------------------------------------------------------------- */

captureRoutes.get('/approvals', requireAuth, requireApprover, wrap(async (req, res) => {
  const orgIds = await scopedOrgIds(req.user);
  const pending = await listReturns({ orgIds, status: STATUS.SUBMITTED, limit: 200 });

  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const chasePeriod = String(req.query.chase || `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, '0')}`);
  const missing = PERIOD_RE.test(chasePeriod) ? await missingReturns({ orgIds, period: chasePeriod }) : [];

  res.type('html').send(page({
    title: 'Approvals', user: req.user, active: '/approvals',
    body: `
<h1>Approvals</h1>
<p class="sub">A submitted return is not counted anywhere until it is approved.
You cannot approve a return you captured yourself.</p>

${messages({
    ok: req.query.approved ? 'Approved. It now counts.' : req.query.sentback ? 'Sent back to the inspector.' : null,
    bad: req.query.error || null,
  })}

${pending.length === 0 ? '<div class="card"><span>Nothing waiting for approval.</span></div>' : `
<div class="scroll"><table>
<tr><th>Month</th><th>Abattoir</th><th>Captured by</th><th></th></tr>
${pending.map((r) => `<tr>
  <td>${esc(monthName(r.period))}</td>
  <td>${esc(r.orgName)}${r.revision > 1 ? ` <span class="pill">revision ${r.revision}</span>` : ''}</td>
  <td class="tiny muted">${esc(r.capturedBy || '—')}</td>
  <td><a href="/returns/${r.frmdId}">Look</a></td>
</tr>
<tr><td colspan="4" style="border:0;padding-top:0">
  <form method="post" action="/approvals/${r.frmdId}/approve" style="display:inline">
    ${csrfField(req.csrfToken)}<button type="submit">Approve</button></form>
  <form method="post" action="/approvals/${r.frmdId}/send-back" style="display:inline-flex;gap:.4rem;margin-left:.5rem">
    ${csrfField(req.csrfToken)}
    <input name="reason" placeholder="Why is it going back?" style="width:22rem">
    <button type="submit" class="ghost">Send back</button></form>
</td></tr>`).join('')}
</table></div>`}

<h2>Who has not submitted — ${esc(monthName(chasePeriod))}</h2>
<form method="get" action="/approvals" class="row" style="margin:0 0 .8rem">
  <input name="chase" value="${esc(chasePeriod)}" style="max-width:9rem" placeholder="YYYY-MM">
  <button type="submit" class="ghost">Check</button>
</form>
${missing.length === 0
    ? '<div class="card"><span>Every active abattoir in scope has a return for that month.</span></div>'
    : `<div class="card"><span>${missing.length} with no return at all — not a nil return, no return.</span>
   <div class="scroll" style="margin-top:.6rem"><table>
   <tr><th>RC</th><th>Abattoir</th></tr>
   ${missing.map((m) => `<tr><td class="tiny">${esc(m.RC)}</td><td>${esc(m.ORG_Name)}</td></tr>`).join('')}
   </table></div></div>`}`,
  }));
}));

captureRoutes.post('/approvals/:id/approve', requireAuth, requireApprover, wrap(async (req, res) => {
  try {
    const ret = await approveReturn({ frmdId: req.params.id, user: req.user });
    await audit({
      user: req.user, action: ACTIONS.RETURN_APPROVED, entityType: 'return', entityId: req.params.id,
      detail: { orgId: ret.orgId, period: ret.period, revision: ret.revision, capturedBy: ret.capturedBy },
      ip: clientIp(req),
    });
    res.redirect('/approvals?approved=1');
  } catch (err) {
    res.redirect(`/approvals?error=${encodeURIComponent(err.message)}`);
  }
}));

captureRoutes.post('/approvals/:id/send-back', requireAuth, requireApprover, wrap(async (req, res) => {
  try {
    await sendBack({ frmdId: req.params.id, user: req.user, reason: req.body.reason });
    await audit({
      user: req.user, action: ACTIONS.RETURN_RETURNED, entityType: 'return', entityId: req.params.id,
      detail: { reason: req.body.reason }, ip: clientIp(req),
    });
    res.redirect('/approvals?sentback=1');
  } catch (err) {
    res.redirect(`/approvals?error=${encodeURIComponent(err.message)}`);
  }
}));
