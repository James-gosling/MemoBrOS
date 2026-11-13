// MemoBrOS main process: windows, hotkeys and the orchestration of the five abilities.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, nativeImage, screen, session, systemPreferences } = require('electron');

if (process.env.MEMOBROS_USER_DATA) app.setPath('userData', process.env.MEMOBROS_USER_DATA);

const store = require('./store');
const shots = require('./screen');
const input = require('./input');
const stt = require('./stt');
const brain = require('./brain');

let overlay, panel, tray;
let task = null;            // { abort: AbortController } — the request currently running
let listening = null;       // 'ask' | 'agent' | 'dictate' | null
let walkthrough = null;     // { title, steps, i }
let pendingConfirm = null;  // { resolve }
let attachments = [];       // [{ name, path }]
let pinnedSkillId = null;
let dictationQueue = Promise.resolve();
let agentRunning = false;

const toPanel = (event) => panel && !panel.isDestroyed() && panel.webContents.send('memo:event', event);
const toOverlay = (event) => overlay && !overlay.isDestroyed() && overlay.webContents.send('memo:event', event);
const say = (text, tag) => { if (!text) return; toPanel({ type: 'message', role: 'memo', text, tag }); toPanel({ type: 'say', text }); toOverlay({ type: 'caption', text }); };
const status = (kind, text = '') => { toOverlay({ type: 'status', kind, text }); toPanel({ type: 'status', kind, text }); };
const pinnedSkill = () => store.listSkills().find((s) => s.id === pinnedSkillId) || null;

// ---- windows ------------------------------------------------------------------
function createOverlay() {
  const d = shots.activeDisplay();
  overlay = new BrowserWindow({
    ...d.bounds, transparent: true, frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setContentProtection(true); // keep our own drawings out of screenshots (macOS / Windows)
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());

  // The buddy follows the real cursor.
  let last = '';
  setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(p);
    const b = overlay.getBounds();
    if (!task && (b.x !== disp.bounds.x || b.y !== disp.bounds.y || b.width !== disp.bounds.width || b.height !== disp.bounds.height)) overlay.setBounds(disp.bounds);
    const key = `${p.x},${p.y}`;
    if (key !== last) { last = key; toOverlay({ type: 'cursor', x: p.x - overlay.getBounds().x, y: p.y - overlay.getBounds().y }); }
  }, 33);
}

function createPanel() {
  const { workArea } = screen.getPrimaryDisplay();
  panel = new BrowserWindow({
    width: 400, height: 620, x: workArea.x + workArea.width - 420, y: workArea.y + workArea.height - 640,
    title: 'MemoBrOS', show: false, alwaysOnTop: true, minWidth: 340, minHeight: 420, autoHideMenuBar: true,
    icon: icon(64),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  panel.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  panel.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
  panel.once('ready-to-show', () => panel.show());
}
const togglePanel = () => (panel.isVisible() ? panel.hide() : panel.show());

// A little sticky-note icon, drawn in code so the repo ships no binary assets.
function icon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const px = (x, y, r, g, b, a = 255) => { const o = (y * size + x) * 4; buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = a; };
  const m = Math.round(size * 0.12), fold = Math.round(size * 0.28);
  for (let y = m; y < size - m; y++) for (let x = m; x < size - m; x++) {
    const inFold = (size - m - x) + (size - m - y) < fold;
    if (inFold) continue;
    const eye = (cx) => Math.hypot(x - cx * size, y - 0.45 * size) < size * 0.07;
    if (eye(0.38) || eye(0.62)) px(x, y, 40, 30, 20); else px(x, y, 255, 205, 60);
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  try {
    tray = new Tray(icon(process.platform === 'darwin' ? 18 : 32));
    const hk = store.getSettings().hotkeys;
    tray.setToolTip('MemoBrOS');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open panel', accelerator: hk.panel, click: () => panel.show() },
      { label: 'Ask about my screen', accelerator: hk.ask, click: () => toggleListen('ask') },
      { label: 'Agent mode', accelerator: hk.agent, click: () => toggleListen('agent') },
      { label: 'Dictate', accelerator: hk.dictate, click: () => toggleListen('dictate') },
      { type: 'separator' },
      { label: 'Quit MemoBrOS', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', togglePanel);
  } catch (e) { console.warn('Tray unavailable:', e.message); }
}

// ---- hotkeys ------------------------------------------------------------------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = store.getSettings().hotkeys;
  const failed = [];
  const reg = (name, fn) => { try { if (!globalShortcut.register(hk[name], fn)) failed.push(hk[name]); } catch { failed.push(hk[name]); } };
  reg('ask', () => toggleListen('ask'));
  reg('agent', () => toggleListen('agent'));
  reg('dictate', () => toggleListen('dictate'));
  reg('next', () => walkMove(1));
  reg('panel', togglePanel);
  reg('approve', () => resolveConfirm(true));
  reg('stop', stopEverything);
  return failed;
}

// ---- running requests ---------------------------------------------------------
async function run(fn) {
  if (task) task.abort.abort();
  const mine = { abort: new AbortController() };
  task = mine;
  try {
    await fn(mine.abort.signal);
  } catch (e) {
    if (!(e.aborted || mine.abort.signal.aborted)) { console.error(e); toPanel({ type: 'message', role: 'error', text: e.message || String(e) }); toOverlay({ type: 'caption', text: e.message || String(e) }); }
  } finally {
    if (task === mine) { task = null; status('idle'); }
  }
}

function stopEverything() {
  if (task) task.abort.abort();
  resolveConfirm(false);
  if (listening) setListening(null);
  toPanel({ type: 'shutup' });
  toOverlay({ type: 'clear' });
  status('idle');
  if (agentRunning) say('Stopped.');
}

async function captureFresh() {
  const display = shots.activeDisplay();
  overlay.setBounds(display.bounds);
  toOverlay({ type: 'clear' });
  await input.sleep(120); // let old annotations leave the screen before the screenshot
  return shots.capture(display);
}

const hooksFor = (shot) => ({
  point: ({ x, y, label }) => toOverlay({ type: 'point', ...shots.toOverlay(shot, x, y), label }),
  draw: (shapes) => toOverlay({
    type: 'draw',
    shapes: shapes.map((s) => {
      const a = shots.toOverlay(shot, s.x, s.y);
      const b = s.x2 == null || s.y2 == null ? null : shots.toOverlay(shot, s.x2, s.y2);
      return { type: s.type, label: s.label, x: a.x, y: a.y, x2: b?.x, y2: b?.y };
    }),
  }),
  memoryChanged: pushState,
});

// ---- abilities 1 + 2: screen-aware answers with pointing ------------------------
function doAsk(text) {
  toPanel({ type: 'message', role: 'user', text });
  return run(async (signal) => {
    status('thinking');
    const shot = await captureFresh();
    let next = null;
    const reply = await brain.ask({
      text, shot, attachments, pinnedSkill: pinnedSkill(), signal,
      hooks: { ...hooksFor(shot), startWalkthrough: (w) => { next = () => startWalkthrough(w); }, startAgent: (t) => { next = () => doAgent(t, true); } },
    });
    say(reply);
    if (next) setImmediate(next);
  });
}

// ---- ability 5: guided walkthroughs ----------------------------------------------
function startWalkthrough({ title, steps }) {
  if (!Array.isArray(steps) || !steps.length) return;
  walkthrough = { title: title || 'Walkthrough', steps: steps.map(String), i: 0 };
  return walkStep();
}
function walkStep() {
  const walk = walkthrough;
  toPanel({ type: 'walk', walk });
  return run(async (signal) => {
    status('thinking', `Step ${walk.i + 1}/${walk.steps.length}`);
    const shot = await captureFresh();
    const reply = await brain.walkStep({ walk, shot, attachments, pinnedSkill: pinnedSkill(), hooks: hooksFor(shot), signal });
    say(reply, `Step ${walk.i + 1}/${walk.steps.length}`);
  });
}
function walkMove(delta) {
  if (!walkthrough) return;
  const i = walkthrough.i + delta;
  if (i < 0) return;
  if (i >= walkthrough.steps.length) { const t = walkthrough.title; walkStop(); say(`That's the last step of ${t}. Nice work!`); return; }
  walkthrough.i = i;
  return walkStep();
}
function walkStop() { walkthrough = null; toPanel({ type: 'walk', walk: null }); toOverlay({ type: 'clear' }); }

// ---- ability 3: agent mode --------------------------------------------------------
function confirm(title, text) {
  resolveConfirm(false);
  toPanel({ type: 'confirm', confirm: { title, text, hotkey: store.getSettings().hotkeys.approve } });
  toOverlay({ type: 'caption', text: `${title} — approve in the MemoBrOS panel`, sticky: true });
  if (!panel.isVisible()) panel.showInactive();
  return new Promise((resolve) => { pendingConfirm = { resolve }; });
}
function resolveConfirm(ok) {
  if (!pendingConfirm) return;
  const p = pendingConfirm;
  pendingConfirm = null;
  toPanel({ type: 'confirm', confirm: null });
  toOverlay({ type: 'caption', text: '' });
  p.resolve(ok);
}

const describe = (name, i) => ({
  click: `${i.double ? 'Double-click' : i.button === 'right' ? 'Right-click' : 'Click'}${i.why ? `: ${i.why}` : ''}`,
  type: `Type "${String(i.text).slice(0, 60)}"`, key: `Press ${i.combo}`, scroll: `Scroll ${i.dy > 0 ? 'down' : 'up'}`, drag: 'Drag', wait: 'Wait',
}[name] || name);

async function execAction(name, i, shot, signal) {
  const label = describe(name, i);
  if (store.getSettings().confirmEachAction && name !== 'wait') {
    if (!(await confirm('Next action', label))) return 'The user declined this action. Ask what they want instead, or finish.';
    panel.hide();
    await input.sleep(250);
  }
  if (signal.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
  toPanel({ type: 'message', role: 'action', text: label });
  toOverlay({ type: 'caption', text: label });
  const at = i.x == null ? null : shots.toInput(shot, i.x, i.y);
  if (at) toOverlay({ type: 'ripple', ...shots.toOverlay(shot, i.x, i.y) });
  switch (name) {
    case 'click': await input.click(at, i.button || 'left', !!i.double); break;
    case 'type': await input.type(String(i.text)); break;
    case 'key': await input.key(i.combo); break;
    case 'scroll': await input.scroll(at, i.dy || 5); break;
    case 'drag': await input.drag(at, shots.toInput(shot, i.x2, i.y2)); break;
    case 'wait': await input.sleep(Math.min(Math.max(i.ms || 1000, 100), 10000)); break;
    default: throw new Error(`Unknown action ${name}`);
  }
  await input.sleep(350);
  return 'ok';
}

function doAgent(taskText, quiet = false) {
  if (!taskText.trim()) { say('What should I do? Say "memo agent" followed by the task.'); return; }
  if (!quiet) toPanel({ type: 'message', role: 'user', text: taskText, tag: 'Agent' });
  return run(async (signal) => {
    status('thinking', 'Planning');
    let shot = await captureFresh();
    const planText = await brain.plan({ task: taskText, shot, pinnedSkill: pinnedSkill(), attachments, signal });
    if (!planText) { say("That's not something I can do for you."); return; }
    toPanel({ type: 'message', role: 'memo', text: planText, tag: 'Plan' });
    toPanel({ type: 'say', text: "Here's my plan. Approve it and I'll get going." });
    if (!(await confirm('Approve this plan?', planText))) { say("Okay, I won't touch anything."); return; }
    agentRunning = true;
    panel.hide(); // hand keyboard focus back to the user's app
    await input.sleep(400);
    status('acting', 'Agent running');
    try {
      shot = await captureFresh();
      const summary = await brain.runAgent({
        task: taskText, planText, shot, pinnedSkill: pinnedSkill(), signal,
        io: {
          capture: async () => { await input.sleep(450); return shots.capture(shot.display); },
          exec: (name, i, s) => execAction(name, i, s, signal),
          confirm: async (q) => { const ok = await confirm('Memo needs your OK', q); if (ok) { panel.hide(); await input.sleep(250); } return ok; },
          narrate: (t) => { toOverlay({ type: 'caption', text: t }); toPanel({ type: 'message', role: 'memo', text: t, tag: 'Agent' }); },
          step: (n) => status('acting', `Agent · step ${n}`),
        },
      });
      panel.showInactive();
      say(summary, 'Done');
    } finally {
      agentRunning = false;
      if (!panel.isVisible()) panel.showInactive();
    }
  });
}

// ---- ability 4: dictation ----------------------------------------------------------
function dictateSegment(pcm) {
  dictationQueue = dictationQueue.then(async () => {
    try {
      let text = await stt.transcribe(pcm, sttProgress);
      if (!text) return;
      if (store.getSettings().dictationPolish && brain.hasKey()) text = await brain.polish(text);
      await input.paste(`${text} `);
      toPanel({ type: 'message', role: 'dictation', text });
    } catch (e) { toPanel({ type: 'message', role: 'error', text: e.message || String(e) }); }
  });
  return dictationQueue;
}
const sttProgress = (pct) => status('thinking', `Downloading speech model… ${pct}%`);

// ---- voice input routing -------------------------------------------------------------
function setListening(mode) {
  listening = mode;
  toPanel({ type: 'listen', mode });
  status(mode ? (mode === 'dictate' ? 'dictating' : 'listening') : task ? 'thinking' : 'idle', mode === 'agent' ? 'Agent — what should I do?' : '');
}
function toggleListen(mode) {
  if (listening) { const was = listening; setListening(null); if (was === mode) return; }
  if (mode === 'dictate' && panel.isFocused()) panel.hide(); // give focus back to the field being dictated into
  if (mode !== 'dictate') { if (task) task.abort.abort(); toPanel({ type: 'shutup' }); }
  setListening(mode);
}

const YES = /^\W*(yes|yeah|yep|sure|ok|okay|approve|go ahead|do it|s[ií]|dale|claro|adelante|oui|ja)\b/i;
const NO = /^\W*(no|nope|cancel|stop|don't|cancela|para|detente|non|nein)\b/i;
const NEXT = /^\W*(next|continue|done|got it|ok|okay|siguiente|listo|ya|contin[uú]a)\b/i;
const BACK = /^\W*(back|previous|go back|atr[aá]s|anterior)\b/i;
const AGENT = /^\W*(?:hey[,\s]+)?memo[,\s]+agent\b[\s,:.-]*/i;

function route(text, mode) {
  text = String(text || '').trim();
  if (!text) return;
  if (pendingConfirm && (YES.test(text) || NO.test(text)) && text.length < 30) return resolveConfirm(YES.test(text));
  if (walkthrough && text.length < 30) {
    if (NEXT.test(text)) return walkMove(1);
    if (BACK.test(text)) return walkMove(-1);
    if (NO.test(text)) { walkStop(); return say('Okay, walkthrough closed.'); }
  }
  if (AGENT.test(text)) return doAgent(text.replace(AGENT, ''));
  if (mode === 'agent') return doAgent(text);
  return doAsk(text);
}

// ---- IPC ---------------------------------------------------------------------------------
function state() {
  const s = store.getSettings();
  return {
    settings: s, hasKey: brain.hasKey(), hasSttKey: !!store.getSecret('stt'), platform: process.platform,
    skills: store.listSkills(), pinnedSkillId, memory: store.getMemory(), attachments, walk: walkthrough, listening,
  };
}
function pushState() { toPanel({ type: 'state', state: state() }); }

const handlers = {
  'state:get': () => state(),
  'settings:save': ({ settings, anthropicKey, sttKey }) => {
    if (settings) store.saveSettings(settings);
    if (anthropicKey !== undefined) store.setSecret('anthropic', anthropicKey.trim());
    if (sttKey !== undefined) store.setSecret('stt', sttKey.trim());
    const failed = registerHotkeys();
    return { ...state(), failedHotkeys: failed };
  },
  request: ({ text, mode }) => { route(text, mode); },
  'listen:toggle': ({ mode }) => toggleListen(mode),
  'listen:ended': () => { if (listening) setListening(null); },
  'audio:segment': async ({ pcm, mode, final }) => {
    const samples = new Float32Array(pcm);
    if (mode === 'dictate') { await dictateSegment(samples); return; }
    if (final && listening) setListening(null);
    status('thinking', 'Transcribing');
    let text = '';
    try { text = await stt.transcribe(samples, sttProgress); }
    catch (e) { status('idle'); toPanel({ type: 'message', role: 'error', text: e.message || String(e) }); return; }
    if (!text) { status('idle'); return; }
    route(text, mode);
  },
  'confirm:answer': ({ ok }) => resolveConfirm(!!ok),
  stop: () => stopEverything(),
  'walk:move': ({ delta }) => { walkMove(delta); },
  'walk:stop': () => walkStop(),
  'attach:pick': async () => {
    const r = await dialog.showOpenDialog(panel, {
      title: 'Attach files for Memo to read', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents & images', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'log', 'js', 'ts', 'py', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }, { name: 'All files', extensions: ['*'] }],
    });
    return handlers['attach:add']({ paths: r.canceled ? [] : r.filePaths });
  },
  'attach:add': ({ paths }) => {
    const errors = [];
    for (const p of paths) {
      try {
        const size = fs.statSync(p).size;
        if (size > 20 * 1024 * 1024) { errors.push(`${path.basename(p)} is larger than 20 MB`); continue; }
        if (!attachments.some((a) => a.path === p)) attachments.push({ name: path.basename(p), path: p, size });
      } catch (e) { errors.push(e.message); }
    }
    return { attachments, errors };
  },
  'attach:remove': ({ path: p }) => { attachments = attachments.filter((a) => a.path !== p); return { attachments }; },
  'skill:save': (skill) => { const id = store.saveSkill(skill); if (pinnedSkillId === skill.id) pinnedSkillId = id; return state(); },
  'skill:delete': ({ id }) => { store.deleteSkill(id); if (pinnedSkillId === id) pinnedSkillId = null; return state(); },
  'skill:pin': ({ id }) => { pinnedSkillId = pinnedSkillId === id ? null : id; return state(); },
  'memory:add': ({ note }) => { if (note.trim()) store.addMemory(note); return state(); },
  'memory:delete': ({ id }) => { store.deleteMemory(id); return state(); },
  'chat:reset': () => { brain.resetHistory(); walkStop(); },
};
ipcMain.handle('memo', async (_e, channel, payload) => {
  if (!Object.prototype.hasOwnProperty.call(handlers, channel)) throw new Error(`Unknown channel ${channel}`);
  return handlers[channel](payload || {});
});

// ---- app lifecycle --------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => panel && panel.show());
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});
    createOverlay();
    createPanel();
    createTray();
    const failed = registerHotkeys();
    if (failed.length) panel.webContents.once('did-finish-load', () => toPanel({ type: 'message', role: 'error', text: `These hotkeys are taken by another app: ${failed.join(', ')}. Change them in Settings.` }));
  });
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

if (process.env.MEMOBROS_TEST) global.__memo = { route, toggleListen, state, resolveConfirm, input, get overlay() { return overlay; }, get panel() { return panel; } };
