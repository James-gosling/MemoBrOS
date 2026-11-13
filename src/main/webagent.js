// A hidden browser that background routines drive: it keeps the user's sign-ins in its own persistent
// profile ("connected accounts"), so routines can read sites and fill web forms without touching the mouse.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const store = require('./store');

const PARTITION = 'persist:memo-web';
let win = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensure() {
  if (win && !win.isDestroyed()) return win;
  session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win = new BrowserWindow({ show: false, width: 1280, height: 900, title: 'MemoBrOS connected accounts', autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) win.loadURL(url); return { action: 'deny' }; });
  win.on('close', (e) => { if (win.isVisible()) { e.preventDefault(); win.hide(); } }); // closing the sign-in window keeps the session
  return win;
}

async function settle() {
  const wc = ensure().webContents;
  await sleep(500);
  for (let i = 0; i < 40 && wc.isLoading(); i++) await sleep(250);
  await sleep(250);
}

// Lets the user sign in to a site once; cookies stay in the background profile.
function showForLogin(url) {
  const w = ensure();
  if (url) w.loadURL(/^https?:\/\//.test(url) ? url : `https://${url}`).catch(() => {});
  w.show();
}

const SNAPSHOT = `(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const all = [...document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [contenteditable=true]')]
    .filter((e) => e.type !== 'hidden' && (e.type === 'file' || visible(e))).slice(0, 150);
  document.querySelectorAll('[data-memo-id]').forEach((e) => e.removeAttribute('data-memo-id'));
  const label = (e) => (e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.innerText || e.placeholder || e.name || e.value || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
  return {
    url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
    elements: all.map((e, i) => { e.setAttribute('data-memo-id', i); return { id: i, kind: e.tagName.toLowerCase() + (e.type && e.tagName === 'INPUT' ? ':' + e.type : ''), label: label(e), value: e.tagName === 'INPUT' && e.type !== 'password' && e.type !== 'file' ? (e.value || '').slice(0, 40) : '' }; }),
  };
})()`;

async function snapshot() {
  const s = await ensure().webContents.executeJavaScript(SNAPSHOT);
  return `Page: ${s.title}\nURL: ${s.url}\n\nInteractive elements:\n${s.elements.map((e) => `[${e.id}] ${e.kind} "${e.label}"${e.value ? ` = "${e.value}"` : ''}`).join('\n') || '(none)'}\n\nText:\n${s.text}`;
}

async function open(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https pages can be opened.');
  try { await ensure().loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(e.message)) throw new Error(`Could not open ${url}: ${e.message}`); }
  await settle();
  return snapshot();
}

const origin = () => { try { return new URL(ensure().webContents.getURL()).origin; } catch { return ''; } };
const on = (id, body) => ensure().webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-memo-id="${Number(id)}"]'); if (!el) return { missing: true }; ${body} })()`);

// What would acting on this element do? Used by the guardrails before the action happens.
async function inspect(id) {
  const info = await on(id, `const form = el.form || el.closest('form'); const submits = (el.tagName === 'BUTTON' && (el.type || 'submit') === 'submit') || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image'));
    return { label: (el.getAttribute('aria-label') || el.innerText || el.value || el.name || '').trim().slice(0, 60), isFile: el.tagName === 'INPUT' && el.type === 'file', submitsForm: !!form && submits, formSends: !!form && (form.method || 'get').toLowerCase() !== 'get' };`);
  if (info.missing) throw new Error(`No element [${id}] on the page. Call browser_read to see the current elements.`);
  return info;
}

async function click(id) {
  await inspect(id);
  await on(id, 'el.scrollIntoView({ block: "center" }); el.click(); return {};');
  await settle();
  return snapshot();
}

async function type(id, text, submit) {
  await inspect(id);
  await on(id, `el.focus();
    if (el.isContentEditable) { el.textContent = ${JSON.stringify(String(text))}; }
    else { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(text))}); }
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    if (${submit ? 'true' : 'false'}) { const form = el.form || el.closest('form'); if (form) form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }
    return {};`);
  await settle();
  return snapshot();
}

// ---- local files -----------------------------------------------------------------
const within = (file, dir) => { const rel = path.relative(dir, file); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

// Resolves a path the model asked for and checks it sits in a folder the user shares with background agents.
function sharedFile(p) {
  let real;
  try { real = fs.realpathSync(path.resolve(String(p))); } catch { throw new Error(`No such file: ${p}`); }
  const ok = store.sharedFolders().some((d) => { try { return within(real, fs.realpathSync(d)); } catch { return false; } });
  if (!ok) throw new Error(`${p} is outside the folders shared with background agents (${store.sharedFolders().join(', ')}).`);
  if (!fs.statSync(real).isFile()) throw new Error(`${p} is not a file.`);
  return real;
}

function listFiles(query = '') {
  const q = String(query).toLowerCase();
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || found.length >= 400) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(full, depth + 1); } else if (e.isFile() && (!q || e.name.toLowerCase().includes(q))) {
        const st = fs.statSync(full);
        found.push({ full, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  for (const d of store.sharedFolders()) walk(d, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, 60).map((f) => `${f.full}  (${Math.ceil(f.size / 1024)} KB, modified ${new Date(f.mtime).toISOString().slice(0, 10)})`).join('\n') || 'No matching files in the shared folders.';
}

// Puts a local file into a page's <input type=file>. The caller must have obtained the user's approval.
async function upload(id, file) {
  const info = await inspect(id);
  if (!info.isFile) throw new Error(`Element [${id}] is not a file-upload field.`);
  const dbg = ensure().webContents.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach('1.3');
  try {
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-memo-id="${Number(id)}"]` });
    if (!nodeId) throw new Error('The upload field disappeared; read the page again.');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] });
  } finally { if (!attached) dbg.detach(); }
  await settle();
  return `Attached ${path.basename(file)} to the upload field.`;
}

const TOOLS = [
  { name: 'browser_open', description: 'Open a web page in the background browser (signed in to the accounts the user connected) and read it.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_read', description: 'Read the current page again: its text and numbered interactive elements.', input_schema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click a numbered element on the current page.', input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'browser_type', description: 'Fill a numbered input, textarea or select on the current page. Set submit to true to submit its form afterwards.', input_schema: { type: 'object', properties: { id: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['id', 'text'] } },
  { name: 'list_files', description: 'List files in the folders the user shares with background agents, newest first. Optional filename filter.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'browser_upload', description: 'Attach a local file (a path from list_files) to a numbered file-upload field on the current page. The user is asked to approve each file and site once.', input_schema: { type: 'object', properties: { id: { type: 'integer' }, path: { type: 'string' } }, required: ['id', 'path'] } },
];

module.exports = { TOOLS, open, snapshot, click, type, inspect, upload, listFiles, sharedFile, origin, showForLogin, get window() { return win; } };
