// MemoBrOS main process: windows, hotkeys and the orchestration of the five abilities.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, dialog, nativeImage, screen, session, systemPreferences } = require('electron');

if (process.env.MEMOBROS_USER_DATA) app.setPath('userData', process.env.MEMOBROS_USER_DATA);

// Platform setup. Linux: run through X11 (XWayland on Wayland sessions), which the always-on-top overlay,
// global hotkeys and synthetic input need. Windows: an app id so notifications and the taskbar group correctly.
if (process.platform === 'linux') {
  // MEMOBROS_DISPLAY=wayland runs natively on Wayland instead (overlay, hotkeys and agent input are then limited).
  app.commandLine.appendSwitch('ozone-platform', process.env.MEMOBROS_DISPLAY === 'wayland' ? 'wayland' : 'x11');
  // The app draws a chat panel and a few vector shapes; it does not need the GPU. On some drivers the GPU process
  // crashes under XWayland and windows never appear, so render in software unless MEMOBROS_GPU=1 asks otherwise.
  if (process.env.MEMOBROS_GPU !== '1') app.disableHardwareAcceleration();
}
if (process.platform === 'win32') app.setAppUserModelId('com.memobros.app');
const startHidden = process.argv.includes('--hidden'); // used by "start with the system"


const store = require('./store');
const shots = require('./screen');
const input = require('./input');
const stt = require('./stt');
const brain = require('./brain');
const llm = require('./llm');
const mcp = require('./mcp');
const web = require('./webagent');
const routines = require('./routines');
const crew = require('./crew');
const gateway = require('./gateway');

let overlay, panel, tray;
let task = null;            // { abort: AbortController } — the request currently running
let listening = null;       // 'ask' | 'agent' | 'dictate' | null
let walkthrough = null;     // { title, steps, i }
let pendingConfirm = null;  // { resolve, timer } — the approval card currently shown
let confirmQueue = Promise.resolve();
let attachments = [];       // [{ name, path }]
let pinnedSkillId = null;
let dictationQueue = Promise.resolve();
let agentRunning = false;

const toPanel = (event) => panel && !panel.isDestroyed() && panel.webContents.send('memo:event', event);
const toOverlay = (event) => overlay && !overlay.isDestroyed() && overlay.webContents.send('memo:event', event);
const say = (text, tag) => { if (!text) return; toPanel({ type: 'message', role: 'memo', text, tag }); toPanel({ type: 'say', text }); toOverlay({ type: 'caption', text }); };
const status = (kind, text = '') => { toOverlay({ type: 'status', kind, text }); toPanel({ type: 'status', kind, text }); };
const notify = (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body: String(body || '').slice(0, 300) }).show(); } catch { /* no notification daemon */ } };
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
  panel.once('ready-to-show', () => { if (!startHidden) panel.show(); });
}
const togglePanel = () => (panel.isVisible() ? panel.hide() : panel.show());

const icon = (size) => nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png')).resize({ width: size, height: size, quality: 'best' });

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
  routines.stop();
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
      hooks: {
        ...hooksFor(shot),
        startWalkthrough: (w) => { next = () => startWalkthrough(w); },
        startAgent: (t) => { next = () => doAgent(t, true); },
        startCrew: (goal) => { next = () => doCrew(goal, true); },
        createRoutine: (draft) => describeRoutine(routines.add(draft)),
        runBackground: (t) => {
          setImmediate(() => routines.runOnce(t).catch((e) => toPanel({ type: 'message', role: 'error', text: e.message })));
          return 'Started in the background. The user will get the result as a notification and in the panel. Tell them that in one short sentence.';
        },
        extraTools: mcp.forModel(),
        callTool: (name, args) => { toPanel({ type: 'message', role: 'action', text: `Using ${name.replace(/^mcp__/, '').replace('__', ' → ')}` }); return routines.mcpWithApproval(name, args, 'Memo'); },
      },
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
// Approval cards are shown one at a time. Resolves true, false, or 'always' (when opts.always offers that choice).
function confirm(title, text, opts = {}) {
  const shown = confirmQueue.then(() => new Promise((resolve) => {
    pendingConfirm = { resolve, timer: opts.timeoutMs ? setTimeout(() => resolveConfirm(false), opts.timeoutMs) : null };
    toPanel({ type: 'confirm', confirm: { title, text, always: opts.always || '', hotkey: store.getSettings().hotkeys.approve } });
    toOverlay({ type: 'caption', text: `${title} — answer in the MemoBrOS panel`, sticky: true });
    if (!panel.isVisible()) panel.showInactive();
    if (opts.notify && !panel.isFocused()) notify('MemoBrOS needs your approval', title);
  }));
  confirmQueue = shown.catch(() => {});
  return shown;
}
function resolveConfirm(answer) {
  if (!pendingConfirm) return;
  const p = pendingConfirm;
  pendingConfirm = null;
  clearTimeout(p.timer);
  toPanel({ type: 'confirm', confirm: null });
  toOverlay({ type: 'caption', text: '' });
  p.resolve(answer);
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

// Runs a desktop agent task. Resolves { status, summary }. opts.routine marks a scheduled run.
async function doAgent(taskText, quiet = false, opts = {}) {
  if (!taskText.trim()) { say('What should I do? Say "memo agent" followed by the task.'); return { status: 'error', summary: 'No task given.' }; }
  if (!quiet) toPanel({ type: 'message', role: 'user', text: taskText, tag: opts.routine ? `Routine · ${opts.routine.name}` : 'Agent' });
  let result = { status: 'stopped', summary: 'Stopped before finishing.' };
  await run(async (signal) => {
    status('thinking', 'Planning');
    let shot = await captureFresh();
    const planText = await brain.plan({ task: opts.routine?.plan ? `${taskText}\n\n(This plan worked last time: ${opts.routine.plan})` : taskText, shot, pinnedSkill: pinnedSkill(), attachments, signal });
    if (!planText) { result = { status: 'error', summary: 'The model declined this task.' }; say("That's not something I can do for you."); return; }
    toPanel({ type: 'message', role: 'memo', text: planText, tag: 'Plan' });
    toPanel({ type: 'say', text: "Here's my plan. Approve it and I'll get going." });
    const approved = await confirm(opts.routine ? `Routine "${opts.routine.name}" is due. Approve this plan?` : 'Approve this plan?', planText, opts.routine ? { notify: true, timeoutMs: 15 * 60 * 1000 } : {});
    if (!approved) { result = { status: 'skipped', summary: 'The plan was not approved, so nothing was touched.' }; say("Okay, I won't touch anything."); return; }
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
          confirm: async (q) => { const ok = await confirm('Memo needs your OK', q); if (ok) { panel.hide(); await input.sleep(250); } return !!ok; },
          narrate: (t) => { toOverlay({ type: 'caption', text: t }); toPanel({ type: 'message', role: 'memo', text: t, tag: 'Agent' }); },
          step: (n) => status('acting', `Agent · step ${n}`),
        },
      });
      result = { status: 'ok', summary };
      panel.showInactive();
      toPanel({ type: 'message', role: 'memo', text: summary, tag: 'Done', routineFrom: opts.routine ? null : { task: taskText, plan: planText } });
      toPanel({ type: 'say', text: summary });
      toOverlay({ type: 'caption', text: summary });
    } finally {
      agentRunning = false;
      if (!panel.isVisible()) panel.showInactive();
    }
  });
  return result;
}

// ---- crew mode: orchestrator + 2–4 subagents (Kiro CLI over ACP, background researchers) -----------
// Resolves { status, summary }.
async function doCrew(goal, quiet = false, opts = {}) {
  if (!goal.trim()) { say('What should the crew work on? Say "memo crew" followed by the goal.'); return { status: 'error', summary: 'No goal given.' }; }
  if (!quiet) toPanel({ type: 'message', role: 'user', text: goal, tag: opts.routine ? `Routine · ${opts.routine.name}` : 'Crew' });
  let result = { status: 'stopped', summary: 'Stopped before finishing.' };
  await run(async (signal) => {
    status('acting', 'Crew · planning');
    try {
      const summary = await crew.run({
        goal, signal,
        io: {
          update: (agents) => {
            toPanel({ type: 'crew', agents: agents.map(({ name, kind, phase, status: st, note, task, branch, integration }) => ({ name, kind, phase, status: st, note, task, branch, integration })) });
            const working = agents.filter((a) => a.status === 'working').length;
            status('acting', `Crew · ${agents.filter((a) => a.status === 'done').length}/${agents.length} done${working ? `, ${working} working` : ''}`);
          },
          confirm: (title, text, o = {}) => confirm(title, text, { notify: true, timeoutMs: 15 * 60 * 1000, ...o }),
        },
      });
      result = { status: 'ok', summary };
      say(summary, 'Crew report');
    } catch (e) {
      if (!e.aborted) result = { status: 'error', summary: e.message || String(e) };
      throw e;
    }
  });
  return result;
}

// ---- routines --------------------------------------------------------------------------
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
const describeRoutine = (r) => `Routine "${r.name}" is scheduled: ${r.scheduleText}. First run: ${when(r.nextRun)}. It runs ${r.crew ? 'as a coding crew in the project folder' : r.desktop ? 'on the screen after the user approves the plan' : 'quietly in the background'}. Tell the user that in one sentence.`;

function doRoutineFromText(text) {
  toPanel({ type: 'message', role: 'user', text });
  return run(async () => {
    status('thinking', 'Scheduling');
    const r = await routines.addFromText(text);
    say(`Done. "${r.name}" will run ${r.scheduleText.replace(/^[A-Z]/, (c) => c.toLowerCase())}. First run: ${when(r.nextRun)}.`, 'Routine');
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
const CREW = /^\W*(?:hey[,\s]+)?memo[,\s]+crew\b[\s,:.-]*/i;
const RECURRING = /^\W*(every|each|cada|todos los|todas las|tous les|toutes les|jeden|ogni)\b/i; // schedules go straight to the routine maker

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
  if (CREW.test(text)) return doCrew(text.replace(CREW, ''));
  if (mode === 'crew') return doCrew(text);
  if (RECURRING.test(text)) return doRoutineFromText(text);
  if (mode === 'agent') return doAgent(text);
  return doAsk(text);
}

// ---- start with the system (so routines keep running) -----------------------------------------
function applyAutostart() {
  const on = !!store.getSettings().launchAtLogin;
  try {
    if (process.platform === 'linux') {
      const file = path.join(app.getPath('home'), '.config', 'autostart', 'memobros.desktop');
      if (!on) { fs.rmSync(file, { force: true }); return; }
      const exec = process.env.APPIMAGE || (app.isPackaged ? process.execPath : `${process.execPath}" "${app.getAppPath()}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=MemoBrOS\nComment=Screen-aware AI buddy\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else if (app.isPackaged || on === false) {
      app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    }
  } catch (e) { console.warn('autostart:', e.message); }
}

// ---- IPC ---------------------------------------------------------------------------------
function state() {
  const s = store.getSettings();
  return {
    settings: s, hasKey: brain.hasKey(), hasSttKey: !!store.getSecret('stt'), platform: process.platform, llm: llm.describe(),
    keys: { openrouter: !!store.getSecret('openrouter'), omniroute: !!store.getSecret('omniroute'), anthropic: !!store.getSecret('anthropic') },
    routines: routines.view(), mcp: mcp.status(), codeAgent: crew.codeAgent(), gateway: gateway.status(), sharedFolders: store.sharedFolders(),
    skills: store.listSkills(), pinnedSkillId, memory: store.getMemory(), attachments, walk: walkthrough, listening,
  };
}
function pushState() { toPanel({ type: 'state', state: state() }); }

const handlers = {
  'state:get': () => state(),
  'settings:save': ({ settings, anthropicKey, sttKey, openrouterKey, omnirouteKey }) => {
    if (settings) store.saveSettings(settings);
    if (openrouterKey !== undefined) store.setSecret('openrouter', openrouterKey.trim());
    if (omnirouteKey !== undefined) store.setSecret('omniroute', omnirouteKey.trim());
    if (anthropicKey !== undefined) store.setSecret('anthropic', anthropicKey.trim());
    if (sttKey !== undefined) store.setSecret('stt', sttKey.trim());
    const failed = registerHotkeys();
    applyAutostart();
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
  'confirm:answer': ({ ok }) => resolveConfirm(ok === 'always' ? 'always' : !!ok),
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
  'models:list': ({ provider }) => llm.listModels(provider),
  // routines
  'routine:create': async ({ text }) => { await routines.addFromText(text); return state(); },
  'routine:fromChat': ({ task, plan }) => { const r = routines.addFromChat({ task, plan }); return { ...state(), createdId: r.id }; },
  'routine:save': async (r) => { await routines.update(r); return state(); },
  'routine:toggle': ({ id, enabled }) => { routines.setEnabled(id, enabled); return state(); },
  'routine:delete': ({ id }) => { routines.remove(id); return state(); },
  'routine:run': ({ id }) => { routines.run(id).catch((e) => toPanel({ type: 'message', role: 'error', text: e.message })); return state(); },
  // custom MCP servers
  'mcp:save': async ({ server, token }) => {
    const id = server.id || `m${Date.now().toString(36)}`;
    const clean = { id, name: String(server.name || 'Server').trim().slice(0, 40), type: server.type === 'http' ? 'http' : 'stdio', command: String(server.command || '').trim(), url: String(server.url || '').trim(), trust: server.trust === 'always' ? 'always' : 'ask', enabled: server.enabled !== false };
    if (clean.type === 'http') new URL(clean.url); // throws on a malformed URL
    const all = store.getSettings().mcpServers;
    const old = all.find((c) => c.id === id);
    store.saveSettings({ mcpServers: old ? all.map((c) => (c.id === id ? { ...old, ...clean } : c)) : [...all, { ...clean, allowedTools: [] }] });
    if (token !== undefined) store.setSecret(`mcp:${id}`, token.trim());
    if (server.env !== undefined) store.setSecret(`mcpenv:${id}`, String(server.env).trim());
    await mcp.sync(id, true); // user-initiated: may open the browser to sign in
    return state();
  },
  'mcp:delete': async ({ id }) => { store.saveSettings({ mcpServers: store.getSettings().mcpServers.filter((c) => c.id !== id) }); store.setSecret(`mcp:${id}`, ''); store.setSecret(`mcpenv:${id}`, ''); store.setSecret(`mcpauth:${id}`, ''); await mcp.sync(); return state(); },
  'mcp:reconnect': async ({ id }) => { await mcp.sync(id || true, true); return state(); },
  // connected accounts + shared folders for background agents
  'web:connect': ({ url }) => { web.showForLogin(url); },
  'folders:pick': async () => {
    const r = await dialog.showOpenDialog(panel, { title: 'Folders background agents may upload from', properties: ['openDirectory', 'multiSelections'] });
    if (!r.canceled && r.filePaths.length) store.saveSettings({ sharedFolders: [...new Set([...store.sharedFolders(), ...r.filePaths])] });
    return state();
  },
  // Kiro Crew gateway: started and stopped only on the user's request
  'gateway:start': () => { gateway.start(); return state(); },
  'gateway:stop': () => { gateway.stop(); return state(); },
  'project:pick': async () => {
    const r = await dialog.showOpenDialog(panel, { title: 'Project folder for the coding agent', properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths[0]) store.saveSettings({ codeAgent: { cwd: r.filePaths[0] } });
    return state();
  },
  'folders:remove': ({ folder }) => { store.saveSettings({ sharedFolders: store.sharedFolders().filter((f) => f !== folder) }); return state(); },
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
    routines.init({
      confirm, notify, changed: pushState,
      // A due desktop routine waits for the user's own request to finish, then asks before taking the screen.
      runCrew: async (r) => { while (task) await input.sleep(2000); return doCrew(r.task, false, { routine: r }); },
      runDesktop: async (r) => { while (task) await input.sleep(2000); return doAgent(r.task, false, { routine: r }); },
      announce: (r, entry, speak) => {
        if (speak && entry.status === 'ok') toPanel({ type: 'say', text: entry.summary });
        notify(`Routine "${r.name}" ${{ ok: 'finished', error: 'failed', stopped: 'was stopped', skipped: 'was skipped' }[entry.status] || entry.status}`, entry.summary);
        if (!r.desktop && !r.crew) toPanel({ type: 'message', role: entry.status === 'error' ? 'error' : 'memo', text: entry.summary, tag: `Routine · ${r.name}` });
      },
    });
    gateway.init(pushState);
    mcp.sync().then(pushState).catch((e) => console.error('MCP', e));
    const failed = registerHotkeys();
    if (failed.length) panel.webContents.once('did-finish-load', () => toPanel({ type: 'message', role: 'error', text: `These hotkeys are taken by another app: ${failed.join(', ')}. Change them in Settings.` }));
  });
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => { globalShortcut.unregisterAll(); mcp.closeAll(); gateway.stop(); });
  app.on('before-quit', () => { app.isQuitting = true; if (web.window && !web.window.isDestroyed()) web.window.destroy(); });
}

if (process.env.MEMOBROS_TEST) global.__memo = { route, toggleListen, state, resolveConfirm, input, routines, web, worktrees: require('./worktrees'), get overlay() { return overlay; }, get panel() { return panel; } };
