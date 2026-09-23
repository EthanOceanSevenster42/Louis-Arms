/* Create one more account, from the console.
 *
 *   npm run create-user -- --username suer --name "S User" --role super
 *   npm run create-user -- --username thabo --name "Thabo M" --role admin --province Gauteng
 *   npm run create-user -- --username jane  --name "Jane D" --role user  --org 1234
 *
 * The ordinary way to issue an account is /admin/users, signed in as a super
 * user, and that is the way to use unless there is a reason not to. This is the
 * other way in: nobody can sign in yet, or the one super user's password is
 * gone. init-db does not help there - it creates an account only when there are
 * none at all, precisely so it cannot quietly mint a second national account on
 * a live system.
 *
 * Whoever runs this already holds the database credentials and could write the
 * row by hand. What this adds is the validation, the hashing and the audit line
 * the web form produces, so an account made in a hurry is not a different kind
 * of account. The audit records the operating system user who ran it, because
 * "created at the console" is not an answer anyone can follow up.
 */
import os from 'node:os';
import { createUser, countUsers, ROLES, ROLE_LABEL } from './auth/users.js';
import { loadSettings } from './settings.js';
import { PROVINCES } from './rc.js';
import { validateConfig, config } from './config.js';
import { closePool } from './db.js';
import { audit, ACTIONS } from './audit.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const USAGE = `
  npm run create-user -- --username <name> --name "<full name>" --role <${ROLES.join('|')}> [options]

    --role super                 national. Everything, plus the register, the
                                 disease list, and who has access.
    --role admin --province <p>  a regional manager, for one province.
    --role user  --org <ORG_ID>  an inspector, at one abattoir.

    --email <address>            optional.
    --password <password>        optional. Left off, one is generated and
                                 printed once, which is the safer default.
                                 Either way it must be changed at first sign-in.
`;

async function main() {
  console.log('\nARMS — create an account\n');
  validateConfig();

  const username = arg('username');
  const fullName = arg('name');
  const role = arg('role');
  const email = arg('email', null);
  const password = arg('password', null);
  const province = arg('province', null);
  const org = arg('org', arg('abattoir', null));

  if (!username || !fullName || !role) {
    console.log(USAGE);
    throw new Error('--username, --name and --role are all required');
  }
  if (!ROLES.includes(role)) {
    console.log(USAGE);
    throw new Error(`--role must be one of ${ROLES.join(', ')}`);
  }

  /* The province list comes from arms.RcProvince, the same overlay the server
   * applies at start-up, so a corrected numbering is honoured here too and this
   * cannot disagree with what the running app would accept. */
  await loadSettings();

  if (role === 'admin' && !province) {
    throw new Error(`a regional manager needs --province. One of: ${PROVINCES.join(', ')}`);
  }
  if (role === 'user' && !org) {
    throw new Error('an inspector needs --org <ORG_ID> — the abattoir on the register');
  }

  let existing;
  try {
    existing = await countUsers();
  } catch (err) {
    throw new Error(`arms.AppUser could not be read — run \`npm run init-db\` first (${err.message.split('\n')[0]})`);
  }
  console.log(`  ${config.databases.forms} on ${config.sql.server} — ${existing} account${existing === 1 ? '' : 's'} so far\n`);

  /* Attributable, and inside the 64 characters the column holds. */
  const createdBy = `console:${os.userInfo().username}`.slice(0, 64);

  const { user, temporaryPassword } = await createUser({
    username, fullName, email, role,
    scopeOrgId: role === 'user' ? Number(org) : null,
    scopeProvince: role === 'admin' ? province : null,
    password, createdBy, mustChangePassword: true,
  });

  await audit({
    action: ACTIONS.USER_CREATED, entityType: 'user', entityId: user.userId,
    detail: {
      username: user.username, role: user.role,
      scopeOrgId: user.scopeOrgId, scopeProvince: user.scopeProvince,
      by: createdBy,
    },
  });

  console.log('  Account created.\n');
  console.log(`    username            ${user.username}`);
  console.log(`    full name           ${user.fullName}`);
  console.log(`    access              ${ROLE_LABEL[user.role]}`);
  if (user.scopeProvince) console.log(`    province            ${user.scopeProvince}`);
  if (user.scopeOrgId) console.log(`    abattoir            ORG_ID ${user.scopeOrgId}`);
  console.log(`    temporary password  ${temporaryPassword ?? '(the one supplied on the command line)'}`);
  if (temporaryPassword) {
    console.log('\n  Write it down now — it is stored only as a hash and cannot be shown again.');
  }
  console.log('  It must be changed at first sign-in.\n');
  if (user.role === 'super') {
    console.log('  This is a national account: the register, the disease list and every');
    console.log('  other account are now in its hands. The audit log carries who made it.\n');
  }
}

main()
  .catch((err) => {
    console.error(`\n  FAILED: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
