/* One-time setup: create the ARMS tables and the first super user.
 *
 *   npm run init-db
 *   npm run init-db -- --username louis --name "Louis Visagie"
 *   npm run init-db -- --username x@y.co.za --name "X Y" --password '...'
 *
 * Safe to run again. The tables are created only if absent, and a super user
 * is created only if no account exists at all - so this cannot be used to
 * quietly mint a second national account on a live system.
 */
import { migrate } from './auth/schema.js';
import { createUser, countUsers, listUsers } from './auth/users.js';
import { validateConfig, config } from './config.js';
import { closePool } from './db.js';
import { audit, ACTIONS } from './audit.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  console.log('\nARMS — first-time setup\n');
  validateConfig();
  console.log(`  ${config.databases.data} / ${config.databases.registry} / ${config.databases.forms} on ${config.sql.server}\n`);

  await migrate();

  const existing = await countUsers();
  if (existing > 0) {
    console.log(`\n  ${existing} account${existing === 1 ? '' : 's'} already exist. No account was created.`);
    const users = await listUsers();
    for (const u of users) {
      console.log(`    ${u.username.padEnd(20)} ${u.role.padEnd(6)} ${u.isActive ? '' : '(disabled)'}`);
    }
    console.log('\n  A super user creates further accounts at /admin/users.\n');
    return;
  }

  const username = arg('username', 'super');
  const fullName = arg('name', 'ARMS Super User');
  const email = arg('email', null);
  /* A password may be supplied for a handover account. Left off, one is
   * generated and printed once, which is the safer default. Either way the
   * account must change it at first sign-in. */
  const password = arg('password', null);

  const { user, temporaryPassword } = await createUser({
    username, fullName, email, password,
    role: 'super', createdBy: 'init-db', mustChangePassword: true,
  });

  await audit({
    action: ACTIONS.USER_CREATED, entityType: 'user', entityId: user.userId,
    detail: { username: user.username, role: 'super', by: 'init-db' },
  });

  console.log('\n  First super user created.\n');
  console.log(`    username            ${user.username}`);
  console.log(`    temporary password  ${temporaryPassword ?? '(the one supplied on the command line)'}`);
  console.log('\n  Write it down now — it is stored only as a hash and cannot be shown again.');
  console.log('  It must be changed at first sign-in.\n');
  console.log('  Then: npm start\n');
}

main()
  .catch((err) => {
    console.error(`\n  FAILED: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
