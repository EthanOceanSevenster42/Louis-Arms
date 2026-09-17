/* Serve the two applications with their values injected from the database.
 *
 * Neither application is modified on disk. The files in "1 - The system" stay
 * exactly as they are - they are the offline artefacts, and an inspector with
 * no signal still needs them to work by double-click. What happens here is that
 * the server reads the file, swaps the frozen block for one built from SQL, and
 * sends the result. The same page, with today's figures.
 */
import fs from 'node:fs/promises';

/* A </script> inside a string literal closes the block early and breaks the
 * page. It cannot occur in JSON produced from this data, but escape it anyway:
 * one abattoir with an odd name should not be able to break the whole file. */
function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/* ---------- the explorer ---------- */

/* The template carries the seam the build script uses:
 *     var DATA = /*__DATA__* / null /*__END__* / ;
 * Injecting between markers rather than by naive replace means the same
 * operation is safe over an already-built file - which matters, because
 * EXPLORER_TEMPLATE can legitimately be pointed at the built 2,4 MB copy if a
 * site has lost the template. */
const EXPLORER_SEAM = /\/\*__DATA__\*\/[\s\S]*?\/\*__END__\*\//;

/* ---------------------------------------------------------------------------
 * The signed-in bar.
 *
 * The explorer is where people land after signing in - it is the thing they
 * came for - so the account controls live on it rather than on a separate
 * home page nobody would visit twice. It is injected at serve time, above the
 * app's own header, and the app's markup is not touched: the offline file has
 * no session, no sign-out and no capture desk to link to, and must stay
 * exactly as it is.
 *
 * Deliberately NOT sticky. The app already has three stacked sticky bars of
 * its own - header, tabs, filters - and adding a fourth to the pile costs a
 * phone half its screen. This scrolls away with the page.
 * ------------------------------------------------------------------------- */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* EVERY CLASS IN HERE IS PREFIXED arms-, AND EVERY ELEMENT IS RESET.
 *
 * This markup is injected into somebody else's stylesheet. The explorer
 * defines .out for its 200-pixel-tall export box, and a plain
 * `<a class="out">Sign out</a>` picked it up and became a 200px box that
 * stretched the whole bar down the page. Nothing here shares a name with
 * .bar .card .empty .expbar .filters .foot .hero .infobox .muted .okbox .out
 * .pill .printhead .q .scroll .tabs .tiny .top .warnbox .wrap - and the reset
 * below means a class added to the app tomorrow cannot do it again either. */
const BAR_CSS = `
#arms-bar{background:#0d2c21;color:#cfe3d9;
  font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  padding:7px 16px;display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;
  border-bottom:1px solid #06170f}
#arms-bar *{box-sizing:border-box}
/* Neutralise anything the host page's CSS might land on these elements. */
#arms-bar a,#arms-bar span,#arms-bar b{width:auto;min-height:0;max-width:none;height:auto;
  margin:0;border:0;background:none;box-shadow:none;font-family:inherit;line-height:inherit;
  resize:none;float:none;position:static}
#arms-bar a{color:#cfe3d9;text-decoration:none;white-space:nowrap;padding:2px 0;
  display:inline-block;font-size:13px}
#arms-bar a:hover{color:#fff;text-decoration:underline}
#arms-bar .arms-who{display:flex;flex-direction:column;line-height:1.25;margin-right:auto;
  padding:0;gap:1px}
#arms-bar .arms-who b{color:#fff;font-size:13.5px;font-weight:700}
#arms-bar .arms-who span{font-size:11px;color:#9dbdaf;font-weight:400}
#arms-bar .arms-nav{display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:0}
#arms-bar a.arms-btn{background:#4fbf8b;color:#06251a;font-weight:700;border-radius:6px;
  padding:5px 11px;font-size:12.5px}
#arms-bar a.arms-btn:hover{background:#6fd3a3;color:#06251a;text-decoration:none}
#arms-bar a.arms-btn2{background:transparent;border:1.5px solid #4fbf8b;color:#eafff3;
  font-weight:700;border-radius:6px;padding:3.5px 10px;font-size:12.5px}
#arms-bar a.arms-btn2:hover{background:rgba(79,191,139,.18);color:#fff;text-decoration:none}
#arms-bar a.arms-back{background:rgba(255,255,255,.13);border-radius:6px;padding:5px 11px;
  font-size:12.5px;color:#fff;font-weight:600}
#arms-bar a.arms-back:hover{background:rgba(255,255,255,.24);color:#fff;text-decoration:none}
#arms-bar a.arms-signout{color:#9dbdaf}
#arms-bar .arms-badge{display:inline-block;background:#b8860b;color:#fff;font-size:10px;
  font-weight:700;border-radius:999px;padding:1px 6px;margin-left:5px;line-height:1.5}
#arms-scope{background:#fff8e6;border-bottom:1px solid #e6d9b3;color:#6b5a1f;
  font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  padding:7px 16px}
/* On a phone this must cost two short rows, not three. The back link and who
 * share the first; the links take the second. Vertical space on the capture
 * form is the inspector's, not ours. */
@media (max-width:640px){
  #arms-bar{padding:6px 12px;gap:5px 12px}
  #arms-bar .arms-who{width:auto;margin-right:auto}
  #arms-bar .arms-who b{font-size:12.5px}
  #arms-bar .arms-who span{font-size:10.5px}
  #arms-bar .arms-nav{gap:13px;width:100%}
  #arms-bar a.arms-back{padding:4px 9px}
}
`;

/* One bar, two configurations - both applications get the same strip so moving
 * between them does not feel like leaving the system.
 *
 * `chrome` is built by the server:
 *   { user, links[], primary?, back?, scopeNote? }
 *   back     { href, label } - renders a back arrow first. The phone app gets
 *            one so an inspector is never stranded in it.
 *   primary  { href, label } - the one green button. The explorer's is
 *            Schedule 8 Mobile.
 */
function extAttrs(l) {
  return l.external ? ' target="_blank" rel="noopener noreferrer"' : '';
}

function armsBar(chrome) {
  if (!chrome || !chrome.user) return '';
  const { user, links = [], primary = null, secondary = [], back = null, scopeNote = '' } = chrome;

  const nav = links.map((l) =>
    `<a href="${esc(l.href)}"${extAttrs(l)}>${esc(l.label)}${
      l.count ? `<span class="arms-badge">${esc(l.count)}</span>` : ''}</a>`).join('');

  const sec = secondary.map((l) =>
    `<a class="arms-btn2" href="${esc(l.href)}"${extAttrs(l)}>${esc(l.label)}</a>`).join('');

  return `<div id="arms-bar">
  ${back ? `<a class="arms-back" href="${esc(back.href)}">&#8592; ${esc(back.label)}</a>` : ''}
  <span class="arms-who"><b>${esc(user.fullName)}</b><span>${esc(user.scopeLabel)}</span></span>
  <span class="arms-nav">
    ${nav}
    ${sec}
    ${primary ? `<a class="arms-btn" href="${esc(primary.href)}"${extAttrs(primary)}>${esc(primary.label)}</a>` : ''}
    <a class="arms-signout" href="/logout">Sign out</a>
  </span>
</div>${scopeNote ? `<div id="arms-scope">${esc(scopeNote)}</div>` : ''}`;
}

export async function renderExplorer(templatePath, payload, chrome = null) {
  const html = await fs.readFile(templatePath, 'utf8');

  if (!EXPLORER_SEAM.test(html)) {
    throw new Error(
      `${templatePath} has no /*__DATA__*/ ... /*__END__*/ marker, so there is nowhere ` +
      `to put the live figures. Point EXPLORER_TEMPLATE at explorer-template.html.`
    );
  }

  let out = html.replace(EXPLORER_SEAM, () => `/*__DATA__*/${safeJson(payload)}/*__END__*/`);

  if (chrome && chrome.user) {
    /* Anchored on the app's mount point rather than on <body>, because <body>
     * may carry attributes and the mount point is what the app itself looks
     * for. If either anchor is ever renamed this fails loudly here instead of
     * silently serving a page with no way to sign out. */
    if (!out.includes('<div id="app"></div>')) {
      throw new Error(
        `${templatePath} has no <div id="app"></div> to put the signed-in bar above.`
      );
    }
    out = out
      .replace('</head>', `<style>${BAR_CSS}</style>\n</head>`)
      .replace('<div id="app"></div>', `${armsBar(chrome)}\n<div id="app"></div>`);
  }

  return out;
}

/* ---------- the phone app ---------- */

/* The whole literal form definition, from the section comment that opens it to
 * the one that starts the next section. Anchoring on the app's own section
 * headings means the replacement survives edits inside the block and fails
 * loudly if the block is ever renamed, rather than silently injecting nothing. */
const MOBILE_SEAM =
  /\/\* -{10} form definition[\s\S]*?(?=\/\* -{10} storage -{10} \*\/)/;

/* Strict ES5 output. The app must run on old phones: no let, no const, no
 * arrow functions, no template literals. JSON literals are ES5-safe, so the
 * data goes out as JSON and only the `var` declarations are written here. */
function es5Block(def) {
  const wc = def.wc.map((g) => {
    const parts = [`g:${safeJson(g.g)}`, `db:${safeJson(g.db)}`];
    if (g.notify) parts.push('notify:true');
    parts.push(`items:${safeJson(g.items)}`);
    return ` { ${parts.join(', ')} }`;
  }).join(',\n');

  const formLine = def.form
    ? `${def.form.name}, FRM_ID ${def.form.id}, version ${def.form.version}`
    : 'form definition';

  return `/* ---------- form definition ----------
   Read live from the Schedule8 form-definition database (Forms/Groups/Items/Parts)
   and the registry database. ${formLine}.
   Served ${def.source.generatedAt} from ${def.source.server}.
   Nothing below is typed by hand; edit the database, not this block.

   Units: condemnation statistics are in HEAD, "Partially Condemned Diseases"
   are in KILOGRAMS, offal is a count of ORGANS. Those three are never added
   together -- in this app or anywhere downstream. */

var SPECIES = ${safeJson(def.species)};

var ORGANS = ${safeJson(def.organs)};

/* CONDEMNATION STATISTICS -- whole carcasses, counted in HEAD.
   g  = what the inspector reads on the phone
   db = the sub-group string as it is stored in the Groups table.
   Both now come from the same row, so they cannot drift apart. */
var WC = [
${wc}
];

/* Partially Condemned Diseases -- KILOGRAMS, not head */
var PC = ${safeJson(def.pc)};

/* OFFAL CONDEMNATIONS -- each condition broken down by organ */
var OFFAL = ${safeJson(def.offal)};

var LAIR = ${safeJson(def.lair)};

/* The abattoirs an inspector may file for: ${def.abattoirRule}.
   ${def.abattoirs.length} plants at the time this page was served. */
var ABATTOIRS = ${safeJson(def.abattoirs)};

`;
}

/* Signed in on a desktop browser, the phone app is still a phone app - a
 * capture form built for a 400px screen, stretched across a monitor, reads
 * like nothing else on the site. Above 700px the whole thing is dropped into
 * a phone-shaped frame instead: fixed width, centred, with a bezel. The frame
 * only exists in this media query, so a real phone (which never matches it)
 * gets exactly the untouched full-bleed layout it always had.
 *
 * `transform` on the shell is not decoration - it gives the shell a
 * containing block of its own, so the app's own `.bar{position:fixed;
 * bottom:0}` action bar pins to the BOTTOM OF THE FRAME rather than the real
 * browser window. Without it the frame would be cosmetic and the app's fixed
 * elements would ignore it completely. */
const PHONE_FRAME_CSS = `
@media (min-width:700px){
  html,body.arms-phone-mode{background:#1b2420;min-height:100%}
  body.arms-phone-mode{display:flex;align-items:center;justify-content:center;
    padding:28px 12px;box-sizing:border-box}
  /* The bezel's top padding is taller than the sides so the notch below has
     somewhere to sit that is NOT the screen area - a notch positioned inside
     an equal 14px padding is taller than the padding itself and dips into the
     app's own content, which is exactly the bug this comment is here to stop
     someone reintroducing. */
  #arms-phone-shell{width:412px;max-width:100%;height:860px;max-height:calc(100vh - 56px);
    background:#0a0a0a;border-radius:44px;padding:34px 14px 14px;box-sizing:border-box;
    box-shadow:0 30px 70px rgba(0,0,0,.55);position:relative}
  #arms-phone-shell::before{content:'';position:absolute;top:10px;left:50%;
    transform:translateX(-50%);width:120px;height:18px;background:#0a0a0a;
    border-radius:9px;z-index:40}
  #arms-phone-screen{width:100%;height:100%;background:#eef1ee;border-radius:26px;
    overflow-y:auto;overflow-x:hidden;position:relative;box-sizing:border-box;
    -webkit-overflow-scrolling:touch;
    scrollbar-width:thin;scrollbar-color:rgba(18,58,44,.35) transparent}
  #arms-phone-screen::-webkit-scrollbar{width:7px}
  #arms-phone-screen::-webkit-scrollbar-track{background:transparent}
  #arms-phone-screen::-webkit-scrollbar-thumb{background:rgba(18,58,44,.35);border-radius:4px}
  #arms-phone-screen::-webkit-scrollbar-thumb:hover{background:rgba(18,58,44,.55)}
  /* The app's own bottom action bar (".bar") is position:fixed, meant for a
     real phone where body is the only thing that ever scrolls. Trapping a
     fixed element inside this nested, transformed screen box (so it would
     clip to the rounded corners instead of the square bezel) turned out to
     be exactly the kind of fixed+transform combination that some browsers
     repaint incorrectly on a full DOM replacement - which this app does on
     every interaction - producing the bar rendering mid-content instead of
     pinned to the bottom.
     ".bar" is always the LAST element of every screen (checked against every
     occurrence of h += '<div class="bar">' in Schedule 8 Mobile.html), so
     sticky is not a compromise
     here: with nothing after it to reveal, a sticky bottom bar behaves
     exactly like the fixed one was meant to, without a transformed ancestor,
     without clipping tricks, and without the repaint bug. */
  #arms-phone-screen .bar{position:sticky !important}
}
`;

export async function renderMobile(appPath, def, chrome = null) {
  const html = await fs.readFile(appPath, 'utf8');

  if (!MOBILE_SEAM.test(html)) {
    throw new Error(
      `${appPath} does not contain the expected "form definition" section, so the live ` +
      `values have nowhere to go. The app's section comments may have been renamed.`
    );
  }

  let out = html.replace(MOBILE_SEAM, () => es5Block(def));

  /* The same strip as the explorer, carrying a way back to it. Without one an
   * inspector who opened the capture form is stranded: the app's own back
   * button walks its internal screens and stops at its home view, which has
   * nowhere further to go.
   *
   * The app defines .back, .bar, .btn, .out and .top of its own, which is
   * exactly why every class here is arms-prefixed and reset. */
  if (chrome && chrome.user) {
    if (!out.includes('<div id="app"></div>')) {
      throw new Error(`${appPath} has no <div id="app"></div> to put the signed-in bar above.`);
    }
    if (!out.includes('<body>')) {
      throw new Error(`${appPath} has no plain <body> to wrap in the phone frame.`);
    }
    out = out
      .replace('</head>', `<style>${BAR_CSS}${PHONE_FRAME_CSS}</style>
</head>`)
      .replace('<div id="app"></div>', `${armsBar(chrome)}
<div id="app"></div>`)
      .replace('<body>', '<body class="arms-phone-mode">\n<div id="arms-phone-shell"><div id="arms-phone-screen">')
      .replace('</body>', '</div></div>\n</body>');
  }

  return out;
}
