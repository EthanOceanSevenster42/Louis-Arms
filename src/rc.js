/* The registration certificate number, and what it encodes.
 *
 * THE ABATTOIR IS ITS REGISTRATION CERTIFICATE NUMBER, NOT ITS NAME.
 * Louis, 15 Aug 2026: "one thing that never changes is its registration
 * certificate no". Names change, owners change, plants close and reopen under
 * new names - and in this register 41 records are the same plant twice.
 *
 * The RC also encodes two things the register states separately and sometimes
 * wrong. Where the register disagrees with the RC, THE RC WINS and the
 * disagreement is reported rather than silently resolved.
 *
 * This lives on its own because the province a certificate encodes is now two
 * things at once: a column in a report, and the scope of an admin user's
 * authority. Those must never be able to disagree.
 */
export const RC_PROV = {
  '1': 'Gauteng', '2': 'Limpopo', '3': 'North West', '4': 'Free State', '5': 'KZN',
  '6': 'Eastern Cape', '7': 'Western Cape', '8': 'Mpumalanga', '9': 'Northern Cape',
};

export const RC_TYPE = {
  R: 'Red meat', P: 'Poultry', G: 'Game', C: 'Crocodile', H: 'Rabbit', I: 'Other',
};

export const PROVINCES = Object.values(RC_PROV);

/* The province a certificate belongs to, or null when the RC does not begin
 * with a recognised digit. Null means "ask the register", never "guess". */
export function provinceOfRc(rc) {
  const d = String(rc || '').charAt(0);
  return RC_PROV[d] !== undefined ? RC_PROV[d] : null;
}

export function typeOfRc(rc) {
  const s = String(rc || '');
  const last = s.charAt(s.length - 1).toUpperCase();
  return RC_TYPE[last] !== undefined ? RC_TYPE[last] : null;
}

export function isProvince(name) {
  return PROVINCES.includes(String(name));
}
