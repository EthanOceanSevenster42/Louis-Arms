/* The disease spelling map, read from disease-name-map.csv.
 *
 * Inspectors type the condition into a free-text box, so the same disease comes
 * back under a dozen spellings - Enzootic Bovine Leukosis alone appears
 * thirteen ways. The map is a CSV and not code, deliberately, so a veterinarian
 * can read it, argue with it and correct it without touching a source file.
 *
 * Two markers carry clinical rulings and are not spelling rules:
 *   =KEEP=   this name is NEVER folded into anything. Recorded as a rule so a
 *            later tidy-up cannot quietly undo a decision made on clinical
 *            grounds. Melanosis and melanoma are two different diseases; FMD
 *            variants are three different cases.
 *   =QUERY=  the name does not belong in a condemnation return at all.
 *            "Brucellosis (suspect)" is a mis-filed entry, not a lesser grade
 *            of brucellosis. Carried through untouched and flagged, never
 *            counted as the disease it names.
 *
 * The general rule: spelling is ours to fix, clinical meaning is not.
 */
import fs from 'node:fs';

/* A hand-rolled reader rather than a dependency. The file is small, the format
 * is fixed, and quoted commas inside the "Why" column are the only subtlety. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* handled by the \n that follows */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function loadDiseaseMap(csvPath) {
  const result = {
    merge: new Map(),    // as typed -> canonical
    keep: new Set(),     // never merged, by clinical ruling
    query: new Set(),    // mis-filed, flagged rather than counted
    loaded: false,
    path: csvPath,
  };

  if (!fs.existsSync(csvPath)) {
    console.warn(`  WARNING: no disease-name-map.csv at ${csvPath} - names go through as typed`);
    return result;
  }

  /* Strip a UTF-8 BOM if the file has one - Excel adds it, and it would
   * otherwise become part of the first column name. */
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(raw);
  const header = rows.shift().map((h) => h.trim());
  const iAs = header.indexOf('AsTyped');
  const iCanon = header.indexOf('CanonicalName');
  if (iAs < 0 || iCanon < 0) {
    throw new Error(`${csvPath} needs AsTyped and CanonicalName columns; found: ${header.join(', ')}`);
  }

  /* KEYS ARE MATCHED WITHOUT REGARD TO CASE.
   *
   * This is not a liberty - it is what the PowerShell extractor does, and the
   * figures depend on it. A PowerShell hashtable compares its keys
   * case-insensitively, so `$nameMap.ContainsKey('EMACIATION')` finds the rule
   * written for 'Emaciation', and `Enzootic Bovine Leucosis` finds
   * `Enzootic bovine leucosis`. A JavaScript Map does not, and porting this
   * literally left fourteen conditions unmerged and split their counts.
   *
   * It is also right on its own terms. Case is spelling, never clinical
   * meaning: "Dead on arrival" and "Dead on Arrival" are the same condition
   * typed twice. Nothing protected by a =KEEP= ruling differs from anything
   * else by case alone - melanosis and melanoma, and the FMD variants, differ
   * by whole words - so folding case cannot undo a veterinarian's decision. */
  for (const r of rows) {
    /* AsTyped IS NOT TRIMMED, deliberately.
     *
     * Two rules in this file exist only to catch a trailing space -
     * "Lumpy Skin Disease " and "Bovine Leukosis " - because that is exactly
     * how an inspector typed them and how they sit in the database. Trimming
     * the key here silently deletes those two rules and splits both conditions
     * across two spellings. PowerShell's Import-Csv does not trim, and neither
     * does this. The map is a data file: it is read as written. */
    const asTyped = r[iAs] || '';
    const canonical = (r[iCanon] || '').trim();
    if (!asTyped.trim()) continue;
    const key = asTyped.toLowerCase();
    if (canonical === '=KEEP=') result.keep.add(key);
    else if (canonical === '=QUERY=') result.query.add(key);
    else if (canonical) result.merge.set(key, canonical);
  }

  /* The build-time guard, kept. A protected name must never also carry a merge
   * rule; if both are ever written, stop rather than silently pick one. */
  for (const k of result.keep) {
    if (result.merge.has(k)) {
      throw new Error(
        `"${k}" is marked =KEEP= and also has a merge rule. Resolve ${csvPath} before serving.`
      );
    }
  }

  result.loaded = true;
  console.log(
    `  disease name map: ${result.merge.size} spellings folded, ` +
    `${result.keep.size} protected from merging, ${result.query.size} flagged as mis-filed`
  );
  return result;
}

/* Returns the canonical spelling, and records which rules actually fired.
 * A rule that never matches is usually a rule written against a name that has
 * since changed - worth finding rather than leaving to rot. */
export function makeCanonicaliser(map) {
  const hits = new Set();
  const canon = (raw) => {
    const s = raw == null ? '' : String(raw);
    const key = s.toLowerCase();
    if (map.merge.has(key)) { hits.add(key); return map.merge.get(key); }
    return s;
  };
  canon.report = () => ({
    matched: hits.size,
    total: map.merge.size,
    unused: [...map.merge.keys()].filter((k) => !hits.has(k)),
  });
  return canon;
}
