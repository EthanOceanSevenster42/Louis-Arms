/* Validating a captured return.
 *
 * This is a port of validate() in `Schedule 8 Mobile.html`, rule for rule. The
 * phone app checks the same things on the device, and that check is a courtesy
 * to the inspector, not a guarantee to the system: anything can POST to this
 * server. The authority has to live here.
 *
 * THE SPLIT MATTERS. A **problem** means the return would assert something the
 * abattoir cannot have observed - more carcasses condemned than slaughtered, a
 * controlled disease with no note. A **warning** means it looks unusual but may
 * well be right, and a human should look rather than be overruled. Nothing is
 * ever silently corrected.
 *
 * BLANK IS NOT ZERO. A blank means nobody looked; a zero means somebody looked
 * and found none. Those are different findings and the system keeps them
 * apart - which is why a figure that was never entered stays out of the return
 * entirely rather than going in as 0.
 */

/* Most organs come one to an animal; kidneys and lungs come in pairs, and some
 * plants count a pluck as one. Anything above this is almost certainly a
 * keying slip - but it stays a warning, because paperwork is not anatomy. */
const ORGAN_MAX = { Heads: 1, Tails: 1, Tongues: 1 };
const organCap = (o) => (Object.hasOwn(ORGAN_MAX, o) ? ORGAN_MAX[o] : 2);

/* null for "nothing here at all", NaN for "something, but not a number".
 * Number('') is 0, which would turn every blank into an asserted nil. */
function strictNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return Number(s);
}

const isWhole = (n) => Number.isFinite(n) && Math.floor(n) === n;
const fmt = (n) => Number(n).toLocaleString('en-ZA').replace(/,/g, ' ');

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodStart(period) { return `${period}-01`; }

export function periodEnd(period) {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/* Group the flat item list back into per-species blocks, which is the shape
 * every rule below is written against. */
function blocksBySpecies(items) {
  const out = new Map();
  const block = (sp) => {
    if (!out.has(sp)) {
      out.set(sp, { slaughtered: null, condPassed: null, wc: {}, pc: {}, offal: {}, lair: {} });
    }
    return out.get(sp);
  };

  for (const it of items) {
    const sp = String(it.specie || '').trim();
    if (!sp) continue;
    const b = block(sp);
    const group = String(it.group || '');
    const sub = String(it.subGroup || '');
    const name = String(it.item || '');

    if (group === 'SLAUGHTERED' && sub === 'Total Slaughtered') b.slaughtered = it.value;
    else if (group === 'SLAUGHTERED' && sub === 'Conditionally Passed Carcases') b.condPassed = it.value;
    else if (group === 'CONDEMNATION STATISTICS' && sub === 'Partially Condemned Diseases') b.pc[name] = it.value;
    else if (group === 'CONDEMNATION STATISTICS') b.wc[name] = { v: it.value, note: it.notes || '', sub };
    else if (group === 'OFFAL CONDEMNATIONS') {
      b.offal[name] = {};
      for (const p of it.parts || []) b.offal[name][String(p.part)] = p.value;
    } else if (group === 'LAIRAGE REPORT') b.lair[name] = it.value;
  }
  return out;
}

const sumHead = (wc) => Object.values(wc).reduce((s, x) => {
  const v = strictNum(x.v);
  return s + (v === null || Number.isNaN(v) ? 0 : v);
}, 0);

const sumKg = (pc) => Object.values(pc).reduce((s, x) => {
  const v = strictNum(x);
  return s + (v === null || Number.isNaN(v) ? 0 : v);
}, 0);

const sumOrgans = (offal) => Object.values(offal).reduce((s, organs) =>
  s + Object.values(organs).reduce((t, v) => {
    const n = strictNum(v);
    return t + (n === null || Number.isNaN(n) ? 0 : n);
  }, 0), 0);

/**
 * @param payload  the phone app's export shape - the capture desk posts the same
 * @param form     { isNotifiable(itemName), knowsItem(group, item), species, organs }
 */
export function validateReturn(payload, form) {
  const probs = [];
  const warns = [];
  const notifs = [];

  const orgId = Number(payload?.abattoir?.orgId);
  if (!orgId) probs.push('No abattoir chosen.');

  const period = String(payload?.period?.month || '');
  /* A plain \d\d also accepts 2026-00 and 2026-99, which the picker will not
   * produce but a hand-written request will. */
  if (!PERIOD_RE.test(period)) probs.push('No valid month chosen.');

  const inspector = String(payload?.inspector || '').trim();
  if (!inspector) probs.push('The inspector\'s name is missing.');

  const items = Array.isArray(payload?.items) ? payload.items : [];

  if (payload?.noSlaughter) {
    if (!String(payload.noSlaughterReason || '').trim()) probs.push('A nil return needs a reason.');
    /* A nil return says nothing was slaughtered. If figures are also captured,
     * one of the two statements is false - and accepting it would drop them
     * without a word. */
    if (items.length) {
      probs.push('This is marked as a nil return, but figures are also captured. ' +
                 'Either clear the nil return or remove the figures.');
    }
    return { probs, warns, notifs, ok: probs.length === 0 };
  }

  const blocks = blocksBySpecies(items);
  if (blocks.size === 0) probs.push('No species captured for this month.');

  for (const [sp, b] of blocks) {
    if (form.species && form.species.length && !form.species.includes(sp)) {
      probs.push(`${sp}: not a species on the Schedule 8 form.`);
    }

    const sl = strictNum(b.slaughtered);
    if (sl === null) probs.push(`${sp}: total slaughtered is blank.`);
    else if (Number.isNaN(sl)) probs.push(`${sp}: total slaughtered is not a number.`);
    else if (sl < 0) probs.push(`${sp}: total slaughtered is negative.`);
    else if (!isWhole(sl)) probs.push(`${sp}: total slaughtered is ${b.slaughtered}. Animals are counted whole.`);

    /* Conditionally passed carcasses were previously exported without ever
     * being checked - rubbish typed here left as an asserted 0. */
    const cp = strictNum(b.condPassed);
    if (cp !== null) {
      if (Number.isNaN(cp)) probs.push(`${sp}: conditionally passed (Cysticercosis) is not a number.`);
      else if (cp < 0) probs.push(`${sp}: conditionally passed (Cysticercosis) is negative.`);
      else if (!isWhole(cp)) probs.push(`${sp}: conditionally passed is ${b.condPassed}. Carcasses are counted whole.`);
      else if (sl !== null && !Number.isNaN(sl) && cp > sl) {
        probs.push(`${sp}: ${fmt(cp)} conditionally passed but only ${fmt(sl)} slaughtered.`);
      }
    }

    for (const [k, cell] of Object.entries(b.wc)) {
      const v = strictNum(cell.v);
      if (v === null || Number.isNaN(v)) probs.push(`${sp} – ${k}: condemned head is blank or not a number.`);
      else if (v < 0) probs.push(`${sp} – ${k}: condemned head is negative.`);
      else if (!isWhole(v)) probs.push(`${sp} – ${k}: ${cell.v} carcasses. Carcasses are counted whole.`);
      else if (v > 0 && form.isNotifiable(k)) {
        notifs.push({ specie: sp, item: k, value: v, note: String(cell.note || '').trim() });
        if (!String(cell.note || '').trim()) {
          probs.push(`${sp} – ${k}: controlled disease needs a note (date, case detail, who was told).`);
        }
      }
    }

    const wcT = sumHead(b.wc);
    if (sl !== null && !Number.isNaN(sl) && sl >= 0 && wcT > sl) {
      probs.push(`${sp}: ${fmt(wcT)} carcasses condemned but only ${fmt(sl)} slaughtered. One of the two is wrong.`);
    }

    /* KILOGRAMS. Decimals are correct here and only here - all 503 decimal
     * values in eleven years sit in this one sub-group. */
    for (const [k, raw] of Object.entries(b.pc)) {
      const v = strictNum(raw);
      if (v === null || Number.isNaN(v)) probs.push(`${sp} – ${k}: partial condemnation (kg) is blank or not a number.`);
      else if (v < 0) probs.push(`${sp} – ${k}: partial condemnation (kg) is negative.`);
    }

    for (const [cond, organs] of Object.entries(b.offal)) {
      let counted = 0;
      let positive = 0;
      for (const [org, raw] of Object.entries(organs)) {
        if (form.organs && form.organs.length && !form.organs.includes(org)) {
          probs.push(`${sp} – ${cond} – ${org}: not an organ on the Schedule 8 form.`);
          continue;
        }
        const v = strictNum(raw);
        if (v === null || Number.isNaN(v)) probs.push(`${sp} – ${cond} – ${org}: not a number.`);
        else if (v < 0) probs.push(`${sp} – ${cond} – ${org}: negative.`);
        else if (!isWhole(v)) probs.push(`${sp} – ${cond} – ${org}: ${raw} organs. Organs are counted whole.`);
        else { counted++; if (v > 0) positive++; }
      }
      /* "nothing counted yet" and "counted, and it was nil" are different
       * statements and get different words. The first one blocks: a condition
       * carrying no count at all would store a container row with nothing
       * behind it - which is exactly the shape that hid 97 369 offal rows from
       * every report for eleven years. */
      if (!counted) probs.push(`${sp} – ${cond}: recorded against offal but no organ counted. Enter the counts, or remove it.`);
      else if (!positive) warns.push(`${sp} – ${cond}: every organ counted came to nil.`);
    }

    /* Sanity check against the animal, organ by organ. One head per beast, two
     * kidneys. Comparing organs with animals is legitimate here because both
     * describe the same herd - what would be wrong is adding them together. */
    if (sl !== null && !Number.isNaN(sl) && sl > 0) {
      for (const [cond, organs] of Object.entries(b.offal)) {
        for (const [org, raw] of Object.entries(organs)) {
          const v = strictNum(raw);
          if (v === null || Number.isNaN(v)) continue;
          const cap = organCap(org);
          if (v > sl * cap) {
            warns.push(`${sp} – ${cond} – ${org}: ${fmt(v)} off ${fmt(sl)} animals, which is more than ${cap} per animal. Check this.`);
          }
        }
      }
    }

    for (const [k, raw] of Object.entries(b.lair)) {
      const v = strictNum(raw);
      if (v === null || Number.isNaN(v)) probs.push(`${sp} – lairage – ${k}: not a number.`);
      else if (v < 0) probs.push(`${sp} – lairage – ${k}: negative.`);
      else if (!isWhole(v)) probs.push(`${sp} – lairage – ${k}: ${raw}. Animals are counted whole.`);
    }

    if (sl === 0 && (wcT > 0 || sumKg(b.pc) > 0 || sumOrgans(b.offal) > 0)) {
      probs.push(`${sp}: nothing slaughtered, yet condemnations are recorded.`);
    }
  }

  return { probs, warns, notifs, ok: probs.length === 0 };
}

export const _internals = { strictNum, isWhole, organCap, blocksBySpecies };
