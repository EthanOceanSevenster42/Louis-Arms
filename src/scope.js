/* Cutting the payload down to what the person in front of it may see.
 *
 * THE RULE (Louis, 17 Aug 2026): an abattoir's condemnation detail is
 * commercially sensitive. "A plant may see where it stands against the average
 * — it may not see who is worse."
 *
 * That sentence rules out two opposite mistakes. Sending the whole national
 * payload to an inspector is the obvious one. Sending only their own rows is
 * the subtler one: it destroys the comparison, and the comparison is the
 * reason the system exists.
 *
 * So the figures stay and the identities go. Every fact row is kept, which is
 * what makes a provincial or national average correct; the abattoirs the
 * viewer may not see are stripped of name, owner, telephone and trading
 * history, and their certificate is masked down to the leading digit — the
 * province — because a comparison against one's own province needs to know
 * which rows are in it.
 *
 * Nothing here filters the fact arrays, and that is deliberate. A fact row
 * carries an index into `aba`, not a name; once `aba` is anonymised the row
 * says "some plant in KZN condemned 40 livers", which is the average and not
 * the accusation. It also means scoping a 2,4 MB payload rewrites 659 rows
 * rather than copying 120 000.
 */

const MASK_NAME = 'Another abattoir';

/* Which abattoir rows this person may see by name.
 *   super  everything
 *   admin  every plant in their province
 *   user   their own plant
 * `orgIds` is what users.scopedOrgIds() returned: null means everything. */
export function visibleAbaIndexes(payload, orgIds) {
  if (orgIds === null) return null;                     // null means "all"

  const wanted = new Set(orgIds.map(Number));
  const visible = new Set();

  /* alias[i] is every register record filed under abattoir i, each carrying
   * its ORG_ID. A plant that has traded under three names has three records
   * and one entry in `aba`; matching on any of them is correct, because they
   * are the same plant. */
  payload.alias.forEach((records, i) => {
    for (const rec of records) {
      if (wanted.has(Number(rec[1]))) { visible.add(i); return; }
    }
  });

  return visible;
}

/* The certificate, reduced to the province it encodes. `5/41` becomes `5/••`,
 * which still sorts into KZN and still cannot be looked up. */
function maskRc(rc) {
  const s = String(rc || '');
  if (!s) return '';
  return s[0] + s.slice(1).replace(/[^/]/g, '•');
}

export function scopePayload(payload, { orgIds, role }) {
  const visible = visibleAbaIndexes(payload, orgIds);

  /* A super user gets the payload untouched - including the object identity,
   * so the cached copy is not duplicated per request. */
  if (visible === null) {
    return {
      ...payload,
      meta: { ...payload.meta, scope: { role, sees: 'every abattoir, named', masked: 0 } },
    };
  }

  const aba = payload.aba.map((row, i) => {
    if (visible.has(i)) return row;
    // [name, province, type, FSA flag, active, reports, rcIndex] - only the
    // name goes. Province and type are what the comparison is drawn against.
    const copy = row.slice();
    copy[0] = MASK_NAME;
    return copy;
  });

  const rc = payload.rc.slice();
  const alias = payload.alias.map((records, i) => (visible.has(i) ? records : []));

  /* rcIndex is per-abattoir here (one certificate, one plant), so masking by
   * abattoir index is safe. */
  payload.aba.forEach((row, i) => {
    if (!visible.has(i)) rc[row[6]] = maskRc(payload.rc[row[6]]);
  });

  return {
    ...payload,
    aba,
    rc,
    alias,
    meta: {
      ...payload.meta,
      scope: {
        role,
        sees: role === 'user'
          ? 'this abattoir, named; every other plant counted but not identified'
          : 'every abattoir in this province, named; the rest counted but not identified',
        named: visible.size,
        masked: payload.aba.length - visible.size,
        note:
          'Figures for abattoirs outside this scope are still counted, so provincial and ' +
          'national comparisons are correct. Their names, owners, contact numbers and ' +
          'trading history are not sent, and their registration certificates are reduced ' +
          'to the province digit.',
      },
    },
  };
}

/* The register list, scoped the same way. Used by /api/register. */
export function scopeRegister(payload, { orgIds }) {
  const visible = visibleAbaIndexes(payload, orgIds);

  return payload.aba.map((row, i) => {
    const [name, pi, ti, afs, act, rep, ri] = row;
    const named = visible === null || visible.has(i);
    return {
      name: named ? name : MASK_NAME,
      rc: named ? payload.rc[ri] : maskRc(payload.rc[ri]),
      province: payload.prov[pi],
      type: payload.tp[ti],
      fsaFlag: Boolean(afs),
      active: Boolean(act),
      /* An abattoir that has never submitted shows dashes, never zeros. It has
       * not reported nil; it has not reported. */
      reports: Boolean(rep),
      reportingSince: rep ? payload.meta.fromYear : null,
      identified: named,
    };
  });
}
