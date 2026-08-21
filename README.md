# 6 — The backend

**Node · serves the two applications in `1 - The system` over HTTP, reads every value live from
the SQL Server databases in `3 - The database`, and writes returns back into them behind a login.**

---

## What this is for

Both applications carried their data frozen inside them. `NAHDIS Explorer.html` is 2,4 MB because
eleven years of figures are compiled in; `Schedule 8 Mobile.html` carried the disease list, the
organ list and 118 abattoirs as literal arrays. Both were correct on the day they were built and
drifted from then on, and neither could write anything back.

Behind this server the same two pages read the database when you open them, an inspector can
capture a return, and a regional manager approves it — which is the step that makes a figure count.

**What has not changed:** the files in `1 - The system` are untouched on disk and still
downloadable. They remain the offline artefacts. An inspector in an abattoir office with no signal
must still be able to open a file and work.

---

## Running it

```
cd "6 - The backend"
npm install
cp .env.example .env      # then fill it in
npm run init-db           # creates the ARMS tables and the first super user
npm start
```

`npm run init-db` prints a temporary password for the first super user **once**. Write it down.
It is stored only as a hash and must be changed at first sign-in.

| Command | What it does |
|---|---|
| `npm run check` | Settings, database, figures, both pages render. Run first, and after any move. |
| `npm run verify -- --password <pw>` | Fetches both pages from a running server and proves the injected values are real. |
| `npm run verify-auth -- --password <pw>` | End-to-end: login, the three layers, capture, approval, revision. **Writes real rows and removes them again.** |
| `npm run init-db` | Creates tables; creates a super user only if no account exists. Safe to re-run. |

---

## Deploying to a cloud server

Read this whole section before starting. Every trap named here cost us at least half a day.

### What you need

| | |
|---|---|
| **Node** | 18 or newer. The app is pure JavaScript — no native modules, no build step. |
| **SQL Server** | 2016 or newer, reachable over **TCP**. Express is enough; the whole dataset is under 40 MB. |
| **The three `.bak` files** | `Schedule8Data.bak`, `NAHDIS_FSA.bak`, `Schedule8.bak`. **Not in this repository — see "The data" below.** |
| **The two applications** | `NAHDIS Explorer.html`, `Schedule 8 Mobile.html`, and `explorer-template.html`. Also not in this repository; they are folders 1 and 2 of the handover. |
| **TLS** | A certificate and a reverse proxy. Sessions are cookies; a cookie on plain HTTP is a password on plain HTTP. |

### 1. Restore the databases

```powershell
.\deploy\1-restore-databases.ps1 -BakFolder "D:\arms-baks"
```

It stages the backups where SQL can read them, builds the `MOVE` clauses from each backup's own
file list, restores all three, and prints the row counts so you can see the data landed. Add
`-Server "sqlprod,1433" -SqlUser sa -SqlPassword "..."` for a remote instance, and `-Suffix "_ARMS"`
if the plain names are taken.

**Three things that will bite you, and the script handles all three:**

- **SQL opens the `.bak`, not you.** Its service account usually cannot read a user profile folder,
  and the failure is a bare `Operating system error 5 (Access is denied)` that reads like a corrupt
  file. Keep backups somewhere the service account can reach.
- **The `.mdf`/`.ldf` paths inside a backup are from the machine it came off** and will not exist on
  yours. Every restore needs `MOVE` clauses built from `RESTORE FILELISTONLY`.
- **The name `NAHDIS_FSA` is not free.** The 2016 trigger on `FormData` writes `NAHDIS_FSA..regions`
  *literally*. If another database on the instance carries that name, the trigger reads that one
  instead — silently. See *the legacy trigger* below.

### 2. Create the login

```powershell
.\deploy\2-create-login.ps1 -Suffix "_ARMS"
```

Creates `arms_app` with the minimum rights, proves it can read what the backend needs, and prints
the `.env` block to paste. **`db_datareader` does not include `EXECUTE`** — the register query calls
the scalar function `GetProvince`, so without an explicit grant every page touching the register
dies with *"The EXECUTE permission was denied"*. The script grants it; a hand-rolled login often
does not.

`db_ddladmin` on the data database is for `init-db` (it creates the `arms` schema and widens one
column). If you would rather production not hold DDL rights, run `init-db` once with an admin
login and then re-run with `-NoDdl`.

### 3. Configure

```
cp .env.example .env
```

Fill in the block the login script printed, then:

```
PUBLIC_URL=https://arms.example.co.za
HOST=127.0.0.1          # nginx fronts it; do not bind publicly
SECURE_COOKIES=true     # required once you are on https
TRUST_PROXY=true        # so the audit trail records the caller, not the proxy
SQL_TRUST_CERT=false    # once SQL Server has a trusted certificate
SYSTEM_DIR=/srv/arms/system
BUILD_DIR=/srv/arms/build
```

**`TRUST_PROXY` must stay off when there is no proxy.** Unproxied, `X-Forwarded-For` is written by
the caller, and believing it lets anyone put any address into a national animal-health audit log.

### 4. Prove it before anyone sees it

```
npm ci --omit=dev
npm run check
npm run init-db          # prints the first super user's password ONCE
npm start
npm run verify -- --password <that password>
```

`npm run check` proves the settings, the connection, the three databases, the headline figures and
that both pages render — on the command line, before a person meets a broken page. Run it after
every move. **Do not run `verify-auth` against production**: it writes real returns and approves
one, and although it removes them again, a national record is not the place to find out it
half-succeeded.

### 5. Run it

Either the container:

```
docker build -f deploy/Dockerfile -t arms-backend .
docker run --env-file .env -p 127.0.0.1:3000:3000 \
  -v /srv/arms/system:/app/system:ro -v /srv/arms/build:/app/build:ro arms-backend
```

or systemd — `deploy/arms.service`, which runs it unprivileged and read-only, since the app writes
nothing to disk at all. All state is in SQL.

Then put `deploy/arms.nginx.conf` in front of it for TLS, and `certbot --nginx`.

### 6. The legacy trigger — decide deliberately

`dbo.FormData` carries `trig_FormData_CheckNotifiableDeseases` from 2016. It fires on approval,
builds a controlled-disease notification, and sends it through `sp_SendMail` — and it hardcodes
`NAHDIS_FSA..regions`.

- Restored under the **original names**, on an instance whose `sp_SendMail` is configured →
  `LEGACY_NOTIFY_TRIGGER=leave`, and notifications keep working as they did.
- Restored under **any other name** → the trigger reads the wrong database or fails the approval
  outright. Set `LEGACY_NOTIFY_TRIGGER=disable`. **Nothing then sends controlled-disease
  notifications — ARMS does not send them yet.** That is a real gap, and the reason handover
  question 7 (*can the server send e-mail, and from which address*) needs answering.

Re-enable at any time: `ALTER TABLE dbo.FormData ENABLE TRIGGER ALL`.

### Before it carries real traffic

- [ ] TLS in front, `SECURE_COOKIES=true`, `HOST=127.0.0.1`
- [ ] `SQL_TRUST_CERT=false` once SQL Server has a trusted certificate
- [ ] `.env` is `0600` and owned by the service user — it holds the SQL password
- [ ] The first super user's temporary password has been changed
- [ ] Backups of `Schedule8Data` scheduled **and a restore tested** — handover question 5
- [ ] Somebody has answered: **is this data allowed to leave South Africa?** Handover question 6.
      Choose the region before the data moves, not after.
- [ ] `/api/health` is reachable from your monitoring and **not** from the public internet

### What this deployment still does not do

No MFA. No password reset by e-mail — a super user resets from `/admin/users`. No rate limiting
beyond the five-attempt account lock. No e-mail of any kind. Put it behind the FSA VPN if you can;
if abattoir staff and provincial state vets need it from outside, that is the trade to raise before
go-live, not after.

---

## The data

**The `.bak` files are deliberately NOT in this repository.**

They contain 155 user accounts with e-mail addresses, telephone numbers, password hashes and nine
South African ID numbers; 360 abattoir owner names and 586 telephone numbers; and eleven years of
per-plant condemnation figures — the same figures this system's entire access-control layer exists
to keep one abattoir from seeing about another.

Ask Louis for **`ARMS-database-for-the-server.zip`** (6,4 MB compressed, 38,2 MB restored). It holds
the three backups and its own read-me. Transfer it out of band — SFTP, or a private blob container
with a short-lived SAS. Not by e-mail, and not into this repository.

Verify what you receive before restoring it:

```powershell
Get-FileHash Schedule8Data.bak -Algorithm SHA256
```

| File | Bytes | SHA-256 |
|---|---|---|
| `NAHDIS_FSA.bak` | 5 486 080 | `0BC700A117429DB22711379313F36851C30DA96881C4FCD9DE37B596BE319912` |
| `Schedule8.bak` | 4 363 776 | `17361038BCC0CC35C0699EB059E4B721BF8D31ADAE1D84C70FD585E10DB7D58A` |
| `Schedule8Data.bak` | 30 203 392 | `C5CCE4E7A7C6294DBCC6B18BC40F5DD39909F4CDD4D67824873308542D7ED920` |

Then confirm the counts the restore script prints: **10 875 returns · 147 611 items · 181 856 organ
rows · 10 356 approved · 2015-12 to 2026-07**. If those do not match, you have the wrong backup or a
truncated transfer — stop and get a clean copy rather than going live with part of a national
animal-health record.

Note this is the **pre-2022-cut archive** — it still holds the rows removed from Louis's working
copy on 17 Aug 2026. That is harmless and probably what you want: ARMS reads from 2022 by
configuration (`ARMS_FROM_YEAR`), so the earlier years are excluded from the reporting but remain
available.

`TeraTree.bak` is not needed. It appears nowhere in the source, has never been examined, and should
not be put on a server before somebody looks at what is in it.

### If the target is Azure SQL Database (PaaS)

`.bak` restore is not supported there — that is a SQL Server / Managed Instance feature. Either use
a VM or Managed Instance, or convert with `SqlPackage` on a machine that has the databases
restored:

```
SqlPackage /a:Export /ssn:localhost /sdn:Schedule8Data /tf:Schedule8Data.bacpac
SqlPackage /a:Import /tsn:yourserver.database.windows.net /tdn:Schedule8Data /sf:Schedule8Data.bacpac /tu:USER /tp:PASSWORD
```

Two things change if you go that way: **cross-database queries do not work on Azure SQL**, and this
backend uses them everywhere (`[DB_REGISTRY].dbo.Organisation` from inside the data database). All
three databases would have to become schemas in one database, and `db.js` adjusted to match — it is
the one place that builds those names, so it is a contained change, but it is not zero. Raise it
before choosing PaaS.

---

## The URLs

Defaults are `HOST=127.0.0.1`, `PORT=3000`. Change either in `.env` and every URL follows,
including the ones printed at startup.

| URL | Who | What |
|---|---|---|
| `/login` | anyone | Sign in. There is no self-registration. |
| `/explorer` | signed in | **NAHDIS Explorer — the landing page.** Scoped to what you may see, and it carries the account controls. |
| `/` | signed in | Redirects to the Explorer |
| `/returns` · `/returns/new` | signed in | **The capture desk** |
| `/approvals` | admin, super | **Approve returns**, and chase who has not filed |
| `/mobile` | signed in | Schedule 8 Mobile, for the abattoirs you cover |
| `/home` | signed in | Summary — drafts and anything awaiting your approval |
| `/admin/users` · `/admin/audit` | super | Who has access · who did what |
| `/api/health` | **anyone** | Connection and row counts. The one route with no session — it is what you check when nothing else works, and it exposes no figures. |
| `/api/data` · `/api/register` · `/api/abattoirs` · `/api/form-definition` | signed in | The data, scoped |
| `POST /api/returns` | signed in | The write API. Takes the phone app's own export shape. |
| `/download/explorer` · `/download/mobile` | see below | The offline files, unchanged |

Add `?refresh=1` to any page to rebuild from SQL immediately.

---

## The Explorer is the landing page

Signing in goes straight to the Explorer. It is what people came for, so the account controls are
injected onto it rather than sitting on a separate home page nobody would visit twice:

- who is signed in, and **what they are scoped to**
- **Returns** and, for an approver, **Approvals** — each with a count when something is waiting
- **Users** and **Audit** for a super user
- a **Schedule 8 Mobile** button
- **Sign out**

The phone app carries the same strip with a **← NAHDIS Explorer** link, so the two applications are
one trail rather than two dead ends — the Mobile button therefore opens in the same tab rather than
a new one. Without a way back an inspector who opened the capture form is stranded: the app's own
back button walks its internal screens and stops at its home view, which has nowhere further to go.
On a phone the strip costs two short rows; vertical space on a capture form is the inspector's.

An inspector also gets a line saying *why* most abattoirs on the page have no name — otherwise the
masking reads as a fault rather than as the rule it is. A super user gets no such line: nothing is
hidden from them, so there is nothing to explain. The bar is built from the person's layer, so an
inspector is never offered a link they would only be refused.

The injection happens at serve time and the Explorer's own markup is untouched — it goes in above
`<div id="app"></div>`, and the render fails loudly if that anchor ever moves rather than quietly
serving a page with no way to sign out. **The offline copy at `/download/explorer` has no bar**, as
it should: it has no session to sign out of.

It is deliberately not sticky. The app already has three stacked sticky bars of its own — header,
tabs, filters — and a fourth would cost a phone half its screen.

**Every class in the injected bar is prefixed `arms-`, and every element is reset.** This markup
lands inside somebody else's stylesheet: the Explorer defines `.out` for its 200-pixel-tall export
box, and a plain `<a class="out">Sign out</a>` picked it up and became a 200px box that stretched
the bar down the page. The phone app is worse — it defines `.back`, `.bar`, `.btn`, `.out` **and**
`.top` of its own. `verify-auth` now fails if any class in either bar is unprefixed, so a class
added to either app tomorrow cannot do it again.

**Neither offline file carries the bar.** `/download/explorer` and `/download/mobile` serve the
files untouched: they have no session to sign out of and no server to go back to, and an inspector
with no signal still has to be able to open one and work.

## One palette

The login page, the capture desk, the approval queue and the admin pages all use the **Explorer's**
colours and type, taken from `explorer-template.html` rather than invented — `#123a2c` header green,
`#0d2c21` band, `#2e8b63` accent, `#eef1ee` page, the same 15px system stack. Signing in, capturing
a return and reading the figures are one system, and a login page in a different set of colours
makes it look like two. That matters most on the page where somebody is being asked to type a
password. If the Explorer's colours change, change them in `src/pages.js` too — the comment at the
top of that file lists them.

---

## The three layers

Implemented from `ARMS - Who may do what.md`, in the order that document sets out — **approval
first, scoping second, the register last**.

| | **user** — inspector | **admin** — regional manager | **super** — national |
|---|---|---|---|
| Captures | own abattoir only | any abattoir in their province | anywhere |
| Sees named | own abattoir | every plant in their province | everything |
| Sees others | counted, **not identified** | counted, not identified | — |
| Approves | no | **yes** | yes |
| Accounts, register | no | no | yes |
| Offline download | no | yes | yes |

**Capture and approval are never the same person.** Enforced on the account *and* on the name, so
one person with two accounts is still caught. This is the rule with teeth: in the recovered record
4 396 of 5 024 approved returns appear captured and approved by the same name.

**Scoping keeps the comparison and drops the identity.** An inspector's payload keeps *every* fact
row — which is what makes a provincial or national average correct — but the plants they may not
see lose their name, owner, telephone and trading history, and their certificate is masked to the
leading province digit. A plant may see where it stands against the average, never who is worse.

The scope is derived from the **registration certificate**, not the register's province column.
The two disagree on six plants and the certificate wins; using the register would put a manager in
charge of a plant no report agrees is theirs.

---

## Writing a return

```
InProgress ──submit──▶ Submitted ──approve──▶ Approved
     ▲                     │                     │
     └──── send back ──────┘                     │
                                                 │
Approved ──revise──▶ new revision, InProgress ───┘
                     and the old row becomes Superseded
```

ARMS counts only `FRMD_Status='Approved'`, and every reporting query already filtered on exactly
that — so **the status column is the mechanism and nothing new was invented for it.**

**Nothing is deleted, only superseded.** A correction opens revision *n+1* as a draft carrying a
copy of the figures. The approved row is untouched until the new revision is itself approved, and
both happen in one transaction — so the counted record holds exactly one approved row for that
abattoir-month at every instant: never two, and never, in between, none. `FRMD_Revision` already
existed and had never been used; this is the first thing to use it.

**The validation is the phone app's, ported rule for rule** (`src/validate-return.js`). The device
check is a courtesy to the inspector; anything can POST to a server, so the authority lives here.
Problems block, warnings do not, and nothing is silently corrected:

- **Blank is not zero.** A blank means nobody looked; a zero means somebody looked and found none.
  A figure never entered stays out of the return entirely.
- More condemned than slaughtered is refused. A controlled disease with no note is refused.
- An offal condition with no organ counted is refused — that is the exact shape that hid 97 369
  offal rows from every report for eleven years.
- Kilograms are decimal and only in `Partially Condemned Diseases`; head, organs and lairage
  animals are whole. The four are never added together.

The capture desk posts ordinary form fields (`sl[Cattle]`, `of[Cattle][Abscessations][Livers]`), so
figures already on screen survive without JavaScript; script only adds new rows.

---

## Two changes made to the recovered database

Both are in `src/auth/schema.js`, both reported every time `init-db` runs.

**1. `FDI_Item` widened from `varchar(50)` to `varchar(100)`.**
`Porcine Reproductive and Respiratory Syndrome (PRRS)` is 52 characters and is an official
controlled-disease name. Written into a `varchar(50)` it silently loses its last two characters,
and a controlled disease that does not match its own name never gets counted. The longest value in
eleven years of existing data is 33 characters, so nothing already recorded is affected. The
handover names this explicitly: *"Widen the column before any new capture path writes to it."*

**2. The 2016 notification trigger — a decision, not a workaround.**
`dbo.FormData` carries `trig_FormData_CheckNotifiableDeseases`, which fires on approval and sends a
controlled-disease notification through `sp_SendMail`. It writes `NAHDIS_FSA..regions` **literally**,
so that name does not follow `DB_REGISTRY`. On this machine, where the registry is restored as
`NAHDIS_FSA_ARMS` and an unrelated empty database happens to be called `NAHDIS_FSA`, the trigger
bound silently to the empty one — and once the app login could not reach it, **every approval
failed**.

`LEGACY_NOTIFY_TRIGGER` decides what happens: `leave` (default) keeps it exactly as it is, `disable`
turns it off on this copy so approvals work. This machine's `.env` says `disable`, with the reason
recorded. **Controlled-disease notification is therefore sent by nothing — ARMS does not yet send
it either. That is a real gap, printed on every run rather than buried.** Re-enabling is one
statement: `ALTER TABLE dbo.FormData ENABLE TRIGGER ALL`.

Everything else ARMS adds lives in its own `arms` schema — `AppUser`, `Session`, `AuditLog` — plus
three lookup indexes. Nothing in `dbo` is dropped, renamed or repurposed.

---

## Nothing is hardcoded

Every server name, database name, port, path and rule is read from `.env`. Not tidiness: the
handover says the databases live on `.\SQLEXPRESS`; this machine has them on the default instance
under different names again; and the FSA cloud server is a third arrangement nobody has specified.
A value compiled into a source file would have been wrong three times already — and the legacy
trigger above is what that mistake actually costs.

**Everything touching user input is a bound parameter** (`sql` in `db.js`). Identifiers built from
configuration are wrapped in `raw()` so a plain interpolation can never become executable.

Passwords are scrypt from Node's own crypto — no dependency, memory-hard, parameters stored inside
the hash so they can be raised later. **The 155 legacy `NAHDIS_FSA..Users` passwords are not
reused**: a 2016 scheme whose salt and iteration count we do not know cannot be verified safely,
and carrying it forward would import a decade-old weakness. ARMS issues its own credentials; the
legacy user id is kept on the account so old returns still attribute correctly.

---

## How the reporting data is produced

`src/explorer-data.js` is a port of `2 - How it is built\extract-data.ps1`, **verified against it**:
every fact row, every dimension and every meta figure identical — 9 149 slaughter rows, 8 772
whole-carcass, 916 kilogram, 102 215 offal, 2 691 lairage, 659 certificates, 164 disease names.

Three things had to be matched exactly, each found by that comparison failing:

- **PowerShell hashtables ignore case; a JavaScript `Map` does not.** Ported literally, fourteen
  conditions went unmerged and the disease list came out at 178 names instead of 164 —
  `Dead on arrival` and `Dead on Arrival` counted as two conditions.
- **The disease map's keys must not be trimmed.** Two rules exist *only* to catch a trailing space
  — `"Lumpy Skin Disease "` and `"Bovine Leukosis "`. A tidy-up `.trim()` deleted both.
- **The connection must open inside the data database.** The restored databases collate
  `Latin1_General_CI_AS` and `master` does not, so the register query dies on a collation conflict
  from anywhere else.

Every query now carries an explicit `ORDER BY`. Which spelling survives depends on which row SQL
returns first, and a national disease list that changes spellings between two identical runs is not
evidence.

---

## What is still not built

- **Authentication is still the open design decision.** These are ARMS's own accounts. Users span
  FSA staff, abattoir staff and provincial government, and FSA's Microsoft 365 directory covers only
  the first — federating covers a third of the people, issuing accounts covers all of them. This is
  the second, built so the first can replace it later.
- **Controlled-disease notification.** The spec gives it to the admin user ("holds the notification
  contact list and sends controlled-disease notifications"). The legacy trigger did it and is now
  off; ARMS does not do it yet. Handover question 7 — *can the server send e-mail, and from which
  address* — has to be answered first.
- **The register and the disease list are read-only.** Third in the specification's build order.
- **No TLS.** `HOST` defaults to `127.0.0.1` for that reason. Put it behind a reverse proxy, set
  `SECURE_COOKIES=true` and `TRUST_PROXY=true`, before anyone real uses it.
- **The other input routes.** Excel import and the machine-readable paper sheet, from
  `ARMS - Getting the data in.md`, are not built. The phone app can now POST to `/api/returns`.

---

## Files

| File | What it is |
|---|---|
| `src/server.js` | Routes, home page, error pages, startup |
| `src/config.js` | Every setting, resolved from `.env` in one place |
| `src/db.js` | Pool, bound-parameter `sql` tag, transactions, three-part names from config |
| `src/explorer-data.js` | The port of `extract-data.ps1` — five fact sets and the register |
| `src/form-definition.js` | The Schedule 8 form and abattoir list, from the form tables |
| `src/disease-map.js` | Reads `disease-name-map.csv`, including the `=KEEP=` guard |
| `src/rc.js` | What a registration certificate encodes — province and plant type |
| `src/scope.js` | Cutting the payload down to what the viewer may see |
| `src/capture.js` | The write path — draft, submit, approve, revise, supersede |
| `src/validate-return.js` | The phone app's validation, ported rule for rule |
| `src/render.js` | Injects live values into the two HTML files at serve time |
| `src/pages.js` | The shared HTML shell |
| `src/audit.js` | Who changed what |
| `src/auth/` | Passwords, accounts and scope, sessions, middleware, schema |
| `src/routes/` | Login, the capture desk and approvals, the super-user pages |
| `src/check.js` · `src/verify-served.js` · `src/verify-auth.js` | The three checks |
| `src/test-cleanup.js` | Removes what `verify-auth` wrote. The only code here that deletes a return. |
