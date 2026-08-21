/* The server-rendered pages.
 *
 * Plain HTML, no client framework and no build step. An abattoir office runs
 * whatever browser it runs, on whatever connection it has, and the thing this
 * has to be is legible and fast. It also means the whole UI is readable in one
 * file by whoever maintains it next.
 *
 * THE PALETTE IS THE EXPLORER'S, taken from explorer-template.html rather than
 * invented here. Signing in, capturing a return and reading the figures are
 * one system, and a login page in a different set of colours makes it look
 * like two - which matters most on the page where somebody is being asked to
 * type a password. If the explorer's colours ever change, change them here too:
 *
 *   #123a2c  the header green        #0d2c21  the darker band
 *   #2e8b63  accent                  #1d6b4f  links
 *   #eef1ee  page background         #16211c  text
 *   #5b6b63  muted text              #dde4e0  borders
 *   #a3311f  controlled/red          #b8860b  notifiable/amber
 */
import { scopeLabel, ROLE_LABEL } from './auth/users.js';

export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0}
body{font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
     background:#eef1ee;color:#16211c}
h1,h2,h3{margin:0;font-weight:700}
a{color:#1d6b4f}

/* the header band, matching the explorer's .top exactly */
.top{background:#123a2c;color:#fff;padding:12px 16px}
.top h1{font-size:18px;line-height:1.2;letter-spacing:.01em}
.top .sub{display:block;font-size:11.5px;font-weight:400;opacity:.78;margin-top:3px}

/* the navigation strip, matching the explorer's .tabs */
.nav{background:#0d2c21;padding:0 8px;display:flex;gap:2px;overflow-x:auto;align-items:center}
.nav a{flex:none;color:#a8c4b7;font-size:13.5px;padding:11px 13px;text-decoration:none;
     border-bottom:3px solid transparent;white-space:nowrap}
.nav a:hover{color:#fff}
.nav a.on{color:#fff;font-weight:700;border-bottom-color:#4fbf8b}
.nav .who{margin-left:auto;color:#9dbdaf;font-size:11.5px;line-height:1.3;padding:6px 13px;
     text-align:right;white-space:nowrap}
.nav .who b{display:block;color:#fff;font-size:12.5px}

.wrap{padding:16px;max-width:1100px;margin:0 auto}
.wrap.narrow{max-width:26rem;padding-top:34px}

h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5b6b63;
   margin:22px 0 10px;font-weight:700}
.sub{color:#5b6b63;margin:4px 0 16px;font-size:13.5px}
.muted{color:#5b6b63}
.tiny{font-size:12px;color:#5b6b63;line-height:1.5}

.card{background:#fff;border-radius:12px;padding:16px;margin:0 0 12px;
      box-shadow:0 1px 3px rgba(0,0,0,.07)}
a.card{display:block;text-decoration:none;color:inherit}
a.card:hover{box-shadow:0 2px 8px rgba(0,0,0,.12)}
.card b{display:block;font-size:15px;margin-bottom:2px;color:#16211c}
.card span{color:#5b6b63;font-size:13px}

label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
      color:#5b6b63;font-weight:700;margin:14px 0 4px}
input,select,textarea{width:100%;font:inherit;padding:8px 10px;border:1px solid #c8d2cc;
      border-radius:7px;background:#fff;color:#16211c}
input:focus,select:focus,textarea:focus{outline:2px solid #2e8b63;outline-offset:-1px;
      border-color:#2e8b63}
input[type=checkbox]{width:auto;margin-right:6px;vertical-align:-1px}

button,.btn{font:inherit;font-size:14px;font-weight:700;padding:9px 16px;border-radius:7px;
     border:1px solid #1d6b4f;background:#1d6b4f;color:#fff;cursor:pointer;
     text-decoration:none;display:inline-block;white-space:nowrap}
button:hover,.btn:hover{background:#2e8b63;border-color:#2e8b63}
button.ghost,.btn.ghost{background:#fff;color:#1d6b4f}
button.ghost:hover,.btn.ghost:hover{background:#f0f6f3}
button.danger{background:#a3311f;border-color:#a3311f}
button:disabled{opacity:.5;cursor:not-allowed}
button.tiny,.btn.tiny{font-size:12px;padding:5px 10px;font-weight:400}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px}

table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
   color:#5b6b63;border-bottom:1px solid #dde4e0;padding:7px 6px;font-weight:700}
td{padding:7px 6px;border-bottom:1px solid #dde4e0;vertical-align:top}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}

.msg{border-radius:9px;padding:11px 14px;margin:12px 0;font-size:13.5px;border:1px solid}
.msg.ok{background:#f6fbf8;border-color:#a9d6c1;color:#1d6b4f}
.msg.warn{background:#fdf9ec;border-color:#e0cd93;color:#7a6212}
.msg.bad{background:#fdf0ed;border-color:#e3b1a6;color:#a3311f}
.msg ul{margin:6px 0 0;padding-left:18px}
.msg b{display:block;margin-bottom:2px}

.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:700;
      letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;
      background:#e4eae7;color:#5b6b63}
.pill.approved{background:#2e8b63;color:#fff}
.pill.submitted{background:#b8860b;color:#fff}
.pill.inprogress{background:#e4eae7;color:#5b6b63}
.pill.superseded{background:#e4eae7;color:#8b968f;text-decoration:line-through}

code{background:#f4f7f5;border:1px solid #dde4e0;border-radius:5px;padding:1px 5px;
     font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
.note{border-left:3px solid #2e8b63;background:#f6fbf8;padding:10px 14px;color:#3d4c45;
      font-size:13px;margin:16px 0;border-radius:0 8px 8px 0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:10px}

/* the signed-out pages: login, and the first-run password change */
.plain{max-width:26rem;margin:0 auto;padding:0 16px 40px}
.brand{text-align:center;padding:38px 0 22px}
.brand .mark{display:inline-block;background:#123a2c;color:#fff;border-radius:12px;
      padding:14px 22px;letter-spacing:.02em}
.brand .mark b{font-size:22px;font-weight:800;display:block;line-height:1.1}
.brand .mark span{font-size:11px;opacity:.8;display:block;margin-top:4px}
.brand .org{color:#5b6b63;font-size:11.5px;margin-top:12px}
`;

export function page({ title, body, user = null, active = '', wide = true }) {
  return `<!doctype html>
<html lang="en-ZA"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#123a2c">
<title>${esc(title)} · ARMS</title>
<style>${CSS}</style></head><body>
${user ? header(user, active) : ''}
<div class="wrap${wide ? '' : ' narrow'}">${body}</div>
</body></html>`;
}

/* The signed-out shell: no navigation to offer, so it leads with the mark
 * instead. Same green, same type, so the login page and the explorer read as
 * one system. */
export function plainPage({ title, body }) {
  return `<!doctype html>
<html lang="en-ZA"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#123a2c">
<title>${esc(title)} · ARMS</title>
<style>${CSS}</style></head><body>
<div class="brand">
  <span class="mark"><b>ARMS</b><span>Animal Health &amp; Disease Information System</span></span>
  <div class="org">Food Safety Agency (Pty) Ltd</div>
</div>
<div class="plain">${body}</div>
</body></html>`;
}

function header(user, active) {
  /* The explorer is the landing page and the hub, so it comes first here too. */
  const links = [['/explorer', 'Explorer'], ['/returns', 'Returns']];
  if (user.role === 'admin' || user.role === 'super') links.push(['/approvals', 'Approvals']);
  links.push(['/mobile', 'Phone app'], ['/home', 'Summary']);
  if (user.role === 'super') links.push(['/admin/users', 'Users'], ['/admin/audit', 'Audit']);
  links.push(['/logout', 'Sign out']);

  return `<header class="top">
  <h1>ARMS<span class="sub">Animal Health &amp; Disease Information System</span></h1>
</header>
<nav class="nav">
  ${links.map(([href, label]) =>
    `<a href="${href}"${active === href ? ' class="on"' : ''}>${esc(label)}</a>`).join('')}
  <span class="who"><b>${esc(user.fullName)}</b>${esc(scopeLabel(user))}</span>
</nav>`;
}

/* The database stores InProgress as one word; a person should not have to read
 * it as one. The class still comes from the stored value, so the colours follow
 * the status rather than the label. */
const STATUS_LABEL = {
  InProgress: 'In progress',
  Submitted: 'Awaiting approval',
  Approved: 'Approved',
  Superseded: 'Superseded',
};

export const statusPill = (s) =>
  `<span class="pill ${String(s).toLowerCase()}">${esc(STATUS_LABEL[s] || s)}</span>`;

export function messages({ ok, warn, bad } = {}) {
  let out = '';
  if (ok) out += `<div class="msg ok">${esc(ok)}</div>`;
  if (warn) out += `<div class="msg warn">${esc(warn)}</div>`;
  if (bad) out += `<div class="msg bad">${esc(bad)}</div>`;
  return out;
}

export function problemList(title, list, kind = 'bad') {
  if (!list || !list.length) return '';
  return `<div class="msg ${kind}"><b>${esc(title)}</b><ul>${
    list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
}

export const csrfField = (token) => `<input type="hidden" name="_csrf" value="${esc(token)}">`;

export { ROLE_LABEL };
