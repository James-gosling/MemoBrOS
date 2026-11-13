// End-to-end test of the resident desktop assistant: floating window, background running, control from outside,
// pause, per-capability permissions and the local wake word. Part 1 runs on X11 (Xvfb). Part 2 runs the app
// natively on Wayland under a headless Weston compositor, when `weston` is installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { _electron } = require('playwright');
const fake = require('./fakeLLM');
const { text, use } = fake;

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'out');
const electronBin = process.env.MEMOBROS_BIN || require('electron');
const appArgs = process.env.MEMOBROS_BIN ? [] : [root];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(150);
  }
}
const results = [];
let api, current = null;
const check = async (name, fn) => {
  api.state.requests.length = 0; api.state.script = [];
  try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); }
  catch (e) {
    results.push([name, 'FAIL']);
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 14).join(' | ')}`);
    const p = current && current.windows().find((w) => w.url().endsWith('panel.html'));
    console.log('      last API requests:', api.state.requests.slice(-4).map((r) => { const m = r.body.messages.at(-1); return JSON.stringify(typeof m.content === 'string' ? m.content : (m.content || []).filter((x) => x.type === 'text').map((x) => x.text)).slice(0, 110); }));
    if (p) console.log('      last panel messages:', await p.locator('.msg').allInnerTexts().then((a) => a.slice(-4)).catch(() => []), `| API requests: ${api.state.requests.length}`);
  }
};

function setup(name, settings) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `memobros-${name}-`));
  const data = path.join(userData, 'xdg-data');
  fs.mkdirSync(path.join(data, 'applications'), { recursive: true });
  const started = path.join(userData, 'app-started');
  fs.writeFileSync(path.join(data, 'applications', 'code.desktop'), `[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=sh -c "echo started >> ${started}" %F\n`);
  const heardFile = path.join(userData, 'heard.txt');
  fs.writeFileSync(heardFile, '');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ providers: { openrouter: { baseUrl: `${api.url}/api/v1` } }, speak: false, ...settings }));
  const env = { ...process.env, OPENROUTER_API_KEY: 'or-test-key', ANTHROPIC_API_KEY: '', MEMOBROS_USER_DATA: userData, MEMOBROS_TEST: '1', MEMOBROS_FAKE_TRANSCRIPT_FILE: heardFile, XDG_DATA_HOME: data, XDG_DATA_DIRS: path.join(data, 'none') };
  return { userData, started, heardFile, env, settingsFile: path.join(userData, 'settings.json') };
}
// Runs a second `memobros <flag>`, the way a desktop action or a custom keyboard shortcut would.
const ctl = (env, flag) => new Promise((resolve) => { const c = spawn(electronBin, [...appArgs, '--no-sandbox', flag], { env, stdio: 'ignore' }); c.on('exit', (code) => resolve(code)); });

async function x11Part() {
  const t = setup('x11', {});
  const app = current = await _electron.launch({ executablePath: electronBin, args: [...appArgs, '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env: t.env });
  const exited = new Promise((resolve) => app.process().on('exit', resolve));
  const byFile = (f) => app.windows().find((w) => w.url().endsWith(f));
  const panel = await until(() => byFile('panel.html'), 'panel window');
  await until(() => byFile('overlay.html'), 'overlay window');
  await panel.waitForSelector('.empty');
  const main = (fn, arg) => app.evaluate(fn, arg);
  const invoke = (channel, payload) => panel.evaluate(([c, p]) => window.memo.invoke(c, p), [channel, payload]);
  const state = () => invoke('state:get');
  const win = () => main(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'MemoBrOS'); return { ...w.getBounds(), visible: w.isVisible(), top: w.isAlwaysOnTop(), resizable: w.isResizable() }; });
  const send = async (mode, message) => { await panel.click(`#modes [data-mode="${mode}"]`); await panel.fill('#text', message); await panel.click('#send'); };
  const lastMemo = () => panel.locator('.msg.memo').last().innerText();
  const lastError = () => panel.locator('.msg.error').last().innerText();
  const confirmTitle = async () => ((await panel.locator('#confirm').isHidden()) ? '' : panel.locator('#confirm-title').innerText());
  const saved = () => JSON.parse(fs.readFileSync(t.settingsFile, 'utf8'));
  // Hands one spoken phrase to the wake-word handler, then clears it so the live microphone path hears silence.
  const hear = async (phrase) => { fs.writeFileSync(t.heardFile, phrase); await main(() => global.__memo.heard(new Float32Array(16000))); fs.writeFileSync(t.heardFile, ''); };

  await check('floating window: frameless, no menu bar, always on top, compact bar and back, position remembered', async () => {
    assert.equal(await main(({ Menu }) => Menu.getApplicationMenu()), null, 'no File / Edit menu bar');
    let w = await win();
    assert.deepEqual([w.width, w.height, w.top, w.visible], [420, 640, true, true]);
    for (const id of ['win-pause', 'win-compact', 'win-hide', 'win-quit']) assert.ok(await panel.locator(`#${id}`).isVisible(), `${id} button`);
    assert.equal(await panel.evaluate(() => getComputedStyle(document.getElementById('titlebar')).webkitAppRegion), 'drag', 'the title strip drags the window');
    const corner = [w.x + w.width, w.y + w.height];
    await panel.click('#win-compact');
    w = await until(async () => { const b = await win(); return b.height === 132 && b; }, 'compact size');
    assert.deepEqual([w.width, w.x + w.width, w.y + w.height, w.resizable], [470, ...corner, false], 'the bar keeps its bottom-right corner');
    assert.ok(await panel.evaluate(() => document.body.classList.contains('compact')));
    assert.ok(await panel.locator('#text').isVisible() && await panel.locator('#mic').isVisible() && await panel.locator('#speaker').isVisible() && !(await panel.locator('#tabs').isVisible()), 'compact bar shows mic, input, speaker; hides the tabs');
    assert.equal(saved().window.compact, true, 'mode is remembered');
    await panel.screenshot({ path: path.join(out, 'desktop-compact.png') });
    await panel.click('#win-compact');
    w = await until(async () => { const b = await win(); return b.height === 640 && b; }, 'expanded size');
    assert.deepEqual([w.width, w.x + w.width, w.y + w.height], [420, ...corner]);
    for (const tab of ['chat', 'routines', 'skills', 'memory', 'settings']) assert.ok(await panel.locator(`#tabs [data-tab="${tab}"]`).isVisible(), `${tab} tab is still there`);
    await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'MemoBrOS').setPosition(140, 90));
    await until(() => saved().window.right === 140 + 420 && saved().window.bottom === 90 + 640, 'position saved');
    await panel.screenshot({ path: path.join(out, 'desktop-expanded.png') });
  });

  await check('background: closing or hiding the window keeps the assistant running; shortcut and control commands bring it back', async () => {
    await main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'MemoBrOS').close());
    await until(async () => !(await win()).visible, 'window hidden after close');
    assert.equal((await state()).paused, false, 'the app still answers with its window closed');
    assert.deepEqual((await state()).hotkeys.failed, [], 'all shortcuts registered');
    await main(() => global.__memo.input.key('ctrl+alt+m')); // a real key press, caught by the global shortcut
    await until(async () => (await win()).visible, 'global shortcut shows the window');
    await main(() => global.__memo.input.key('ctrl+alt+m'));
    await until(async () => !(await win()).visible, 'global shortcut hides it again');
    assert.equal(await ctl(t.env, '--toggle'), 0);
    await until(async () => (await win()).visible, '--toggle shows');
    await panel.click('#win-hide');
    await until(async () => !(await win()).visible, 'hide button hides');
    await ctl(t.env, '--show'); await until(async () => (await win()).visible, '--show shows');
    await ctl(t.env, '--hide'); await until(async () => !(await win()).visible, '--hide hides');
    await ctl(t.env, '--toggle'); await until(async () => (await win()).visible, '--toggle shows again');
    assert.equal(app.windows().filter((w) => w.url().endsWith('panel.html')).length, 1, 'a second launch never opens a second assistant');
    assert.match((await state()).hotkeys.fallback, / --toggle$/, 'the fallback command for a custom shortcut is offered');
  });

  await check('pause is different from hide and quit: nothing listens, runs or fires until resumed', async () => {
    api.state.script = [() => [text(JSON.stringify({ name: 'Soon', task: 'Say hi', cron: null, run_once_at: new Date(Date.now() + 1200).toISOString(), schedule_text: 'In a moment', needs_screen: false }))]];
    const id = (await invoke('routine:create', { text: 'in a moment say hi' })).routines.at(-1).id;
    await panel.click('#win-pause');
    await until(async () => (await state()).paused, 'paused');
    assert.ok(await panel.locator('#ind-paused').isVisible(), 'paused indicator');
    assert.ok((await win()).visible, 'the window is still open while paused');
    const registered = () => main(({ globalShortcut }) => ['CommandOrControl+Alt+Space', 'CommandOrControl+Alt+A', 'CommandOrControl+Alt+D', 'CommandOrControl+Alt+M'].map((k) => globalShortcut.isRegistered(k)));
    assert.deepEqual(await registered(), [false, false, false, true], 'only show/hide stays bound');
    api.state.requests.length = 0;
    await send('ask', 'are you there?');
    await until(async () => (await lastError()).includes('paused'), 'request refused while paused');
    await sleep(1500);
    await main(() => global.__memo.routines.tick());
    await sleep(600);
    assert.equal((await state()).routines.find((r) => r.id === id).lastRun, null, 'a due routine does not fire while paused');
    assert.equal(api.state.requests.length, 0);
    assert.equal(await ctl(t.env, '--resume'), 0);
    await until(async () => !(await state()).paused, 'resumed from outside');
    assert.deepEqual(await registered(), [true, true, true, true]);
    api.state.script = [() => [text('Hi there.')]];
    await main(() => global.__memo.routines.tick());
    await until(async () => (await state()).routines.find((r) => r.id === id).lastRun, 'the routine runs after resuming');
  });

  await check('permissions: nothing is captured, heard or controlled until each capability is allowed', async () => {
    assert.deepEqual((await state()).settings.permissions, { screen: false, microphone: false, control: false }, 'everything starts off');
    api.state.requests.length = 0;
    await send('ask', 'what is on my screen?');
    await until(async () => (await confirmTitle()) === 'Let MemoBrOS look at your screen?', 'screen consent card');
    await panel.screenshot({ path: path.join(out, 'desktop-permission.png') });
    await panel.click('#confirm-no');
    await until(async () => (await lastError()).includes('Screen capture is turned off'), 'refusal explained');
    assert.equal(api.state.requests.length, 0, 'no screenshot left the machine');
    api.state.script = [() => [text('I can see your desktop.')]];
    await send('ask', 'what is on my screen?');
    await until(async () => (await confirmTitle()) === 'Let MemoBrOS look at your screen?', 'asked again');
    const seen = panel.evaluate(() => new Promise((resolve) => { const el = document.getElementById('ind-screen'); const o = new MutationObserver(() => { if (el.classList.contains('on')) { o.disconnect(); resolve(true); } }); o.observe(el, { attributes: true }); setTimeout(() => resolve(el.classList.contains('on')), 8000); }));
    await panel.click('#confirm-yes');
    await until(async () => (await lastMemo()).includes('I can see your desktop'), 'answer');
    assert.equal(await seen, true, 'the "screen" indicator lit up during the capture');
    assert.ok(api.state.requests[0].body.messages.at(-1).content.some((p) => p.type === 'image_url'));
    assert.equal(saved().permissions.screen, true);
    api.state.script = [() => [text('No card this time.')]];
    await send('ask', 'and now?');
    await until(async () => (await lastMemo()).includes('No card this time'), 'allowed capability does not ask again');
    // microphone
    await main(() => { global.__memo.toggleListen('ask'); });
    await until(async () => (await confirmTitle()) === 'Let MemoBrOS use the microphone?', 'microphone consent card');
    await panel.click('#confirm-no');
    await sleep(400);
    assert.equal((await state()).listening, null, 'not listening without permission');
    // mouse and keyboard
    await send('agent', 'click something');
    await until(async () => (await confirmTitle()) === 'Let MemoBrOS use the mouse and keyboard?', 'control consent card');
    await panel.click('#confirm-no');
    await until(async () => (await lastMemo()).includes("won't control the mouse and keyboard"), 'agent refused without permission');
    // revoking in Settings takes effect
    await invoke('permission:set', { name: 'screen', value: false });
    api.state.requests.length = 0;
    await send('ask', 'look again');
    await until(async () => (await confirmTitle()) === 'Let MemoBrOS look at your screen?', 'revoked permission asks again');
    await panel.click('#confirm-yes');
    await until(() => api.state.requests.length === 1, 'request after re-allowing');
  });

  await check('wake word "ARVI": off by default, local, bilingual; ignores speech not addressed to it; spoken approvals need the name', async () => {
    let st = await state();
    assert.deepEqual([st.settings.wake.enabled, st.settings.wake.word, st.wakeOn], [false, 'ARVI', false]);
    assert.deepEqual(st.settings.voiceLanguages, ['es-MX', 'en-US']);
    api.state.requests.length = 0;
    await hear('ARVI, analiza mi pantalla');
    assert.equal(api.state.requests.length, 0, 'nothing happens while the wake word is off');
    const arming = invoke('wake:set', { enabled: true });
    await until(async () => (await confirmTitle()) === 'Let MemoBrOS use the microphone?', 'turning it on asks for the microphone');
    await panel.click('#confirm-yes');
    st = await arming;
    assert.equal(st.wakeOn, true);
    await until(async () => (await panel.locator('#ind-mic').innerText()).toLowerCase() === 'mic · arvi', 'mic indicator shows the wake word is armed');
    // not addressed to the assistant → dropped, nothing sent anywhere
    const users = await panel.locator('.msg.user').count();
    for (const phrase of ['abre Visual Studio Code', "let's arrive at the station", 'sí, hazlo']) await hear(phrase);
    assert.equal(api.state.requests.length, 0); assert.equal(await panel.locator('.msg.user').count(), users);
    assert.ok(!fs.existsSync(t.started));
    // local commands, Spanish and English
    await hear('ARVI, oculta MemoBrOS'); await until(async () => !(await win()).visible, 'hidden by voice');
    await hear('Arvi, show MemoBrOS'); await until(async () => (await win()).visible, 'shown by voice');
    await hear('Harvey, abre Visual Studio Code.');
    await until(() => fs.existsSync(t.started), 'the app was opened');
    await until(async () => (await lastMemo()) === 'Abriendo Visual Studio Code.', 'spoken confirmation in Spanish');
    await hear('ARVI, open Visual Studio Code');
    await until(async () => (await lastMemo()) === 'Opening Visual Studio Code.', 'and in English');
    assert.equal(api.state.requests.length, 0, 'local commands never call a model');
    // anything else goes to the assistant as a normal request
    api.state.script = [() => [text('Veo tu escritorio.')]];
    await hear('ARVI, analiza mi pantalla');
    await until(async () => (await lastMemo()) === 'Veo tu escritorio.', 'answer to a spoken request');
    assert.equal(api.state.requests[0].body.messages.at(-1).content.find((p) => p.type === 'text').text, 'analiza mi pantalla');
    // a sensitive action still needs approval, and "yes" only counts with the wake word
    await invoke('permission:set', { name: 'control', value: true });
    api.state.script = [() => [text('1. Click the button')], () => [use('done', { summary: 'Hecho.' })]];
    await hear('ARVI, memo agent, haz clic en el botón');
    await until(async () => (await confirmTitle()) === 'Approve this plan?', 'the plan waits for approval');
    await hear('sí');
    await sleep(500);
    assert.equal(await confirmTitle(), 'Approve this plan?', 'an unaddressed "sí" does not approve');
    await hear('ARVI, sí');
    await until(async () => (await lastMemo()).includes('Hecho.'), 'approved by name', 30000);
    // text the recogniser invents from noise (a phrase in a loop) is never acted on, by wake word or by hotkey
    const loop = `ARVI, I'm not sure if I can ${'get a chance to '.repeat(30)}get`;
    api.state.requests.length = 0;
    const before = await panel.locator('.msg.user').count();
    await hear(loop); await sleep(300);
    fs.writeFileSync(t.heardFile, loop.replace('ARVI, ', ''));
    await panel.evaluate(() => window.memo.invoke('audio:segment', { pcm: new Float32Array(16000).buffer, mode: 'ask', final: true }));
    fs.writeFileSync(t.heardFile, '');
    await until(async () => (await lastError()).includes('No te entendí bien'), 'asks the user to repeat instead');
    assert.equal(api.state.requests.length, 0, 'nothing invented reaches the model'); assert.equal(await panel.locator('.msg.user').count(), before);
    // the real microphone path: armed recording → spoken segment → local transcript → command
    fs.writeFileSync(t.heardFile, 'ARVI, oculta la ventana');
    await until(async () => !(await win()).visible, 'a phrase from the microphone hid the window', 25000);
    fs.writeFileSync(t.heardFile, '');
    await ctl(t.env, '--show');
    // "stop listening" by voice, and the pause switch, both disarm it
    await hear('ARVI, deja de escuchar');
    await until(async () => !(await state()).wakeOn, 'disarmed by voice');
    assert.equal(saved().wake.enabled, false);
    await until(async () => !(await panel.locator('#ind-mic').isVisible()), 'mic indicator off');
    // a custom wake word
    await invoke('settings:save', { settings: { wake: { word: 'Memo' } } });
    await invoke('wake:set', { enabled: true });
    await hear('ARVI, oculta MemoBrOS'); await sleep(300);
    assert.ok((await win()).visible, 'the old word no longer works');
    await hear('Memo, hide MemoBrOS'); await until(async () => !(await win()).visible, 'the new word does');
    await ctl(t.env, '--show');
    await invoke('wake:set', { enabled: false });
  });

  await check('quit is explicit: the ⏻ button and --quit end the process; --quit with nothing running starts nothing', async () => {
    assert.ok(app.process().exitCode === null, 'still running after all of the above');
    await panel.click('#win-quit').catch(() => {});
    assert.ok(await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]), 'the process ended');
    const lone = setup('lone', {});
    const t0 = Date.now();
    assert.equal(await ctl(lone.env, '--quit'), 0);
    assert.ok(Date.now() - t0 < 8000 && !fs.existsSync(path.join(lone.userData, 'routines.json')));
  });
  await app.close().catch(() => {});
}

// A machine where the app can find no microphone (as reported from a real Ubuntu laptop): no fake audio device here.
async function noMicPart() {
  const t = setup('nomic', { permissions: { screen: true, microphone: true, control: true } });
  const app = current = await _electron.launch({ executablePath: electronBin, args: [...appArgs, '--no-sandbox'], env: t.env });
  try {
    const panel = await until(() => app.windows().find((w) => w.url().endsWith('panel.html')), 'panel window');
    await panel.waitForSelector('.empty');
    const invoke = (channel, payload) => panel.evaluate(([c, p]) => window.memo.invoke(c, p), [channel, payload]);
    await check('no microphone: one clear explanation, the wake word switches itself off and says why, and there is a test button', async () => {
      await panel.click('#tabs [data-tab="settings"]');
      await panel.check('#set-wake');
      await until(async () => (await panel.locator('#wake-note').innerText()).includes('cannot find any microphone'), 'reason shown next to the checkbox');
      await until(async () => !(await panel.locator('#set-wake').isChecked()), 'checkbox returns to off');
      assert.equal((await invoke('state:get')).wakeOn, false);
      assert.ok(!(await panel.locator('#ind-mic').isVisible()), 'the mic indicator is not left on');
      for (let i = 0; i < 3; i++) { await app.evaluate(() => global.__memo.toggleListen('ask')); await sleep(500); }
      await panel.click('#tabs [data-tab="chat"]');
      const errors = await panel.locator('.msg.error').allInnerTexts();
      assert.equal(errors.length, 1, 'the same problem is reported once, not once per attempt');
      assert.match(errors[0], /cannot find any microphone\. In your system settings open Sound → Input/);
      await panel.click('#tabs [data-tab="settings"]');
      await panel.click('#mic-test');
      await until(async () => (await panel.locator('#mic-test-note').innerText()).includes('cannot find any microphone'), 'test button reports the same');
      assert.equal(await panel.locator('#set-mic option').count(), 1, 'only "System default" is offered when nothing is found');
      await panel.screenshot({ path: path.join(out, 'desktop-no-microphone.png') });
    });
  } finally { await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {}); await app.close().catch(() => {}); }
}

async function waylandPart() {
  if (spawnSync('which', ['weston']).status !== 0) { console.log('SKIP  native Wayland run (weston is not installed)'); return; }
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-xdg-'));
  fs.chmodSync(runtime, 0o700);
  const weston = spawn('weston', ['--backend=headless', '--socket=memo-wl', '--width=1280', '--height=800'], { env: { ...process.env, XDG_RUNTIME_DIR: runtime }, stdio: 'ignore' });
  await until(() => fs.existsSync(path.join(runtime, 'memo-wl')), 'weston socket', 10000);
  const t = setup('wayland', { permissions: { screen: true, microphone: true, control: true } });
  const env = { ...t.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: 'memo-wl', XDG_SESSION_TYPE: 'wayland' };
  delete env.DISPLAY;
  let app;
  try {
    app = current = await _electron.launch({ executablePath: electronBin, args: [...appArgs, '--no-sandbox'], env });
    const panel = await until(() => app.windows().find((w) => w.url().endsWith('panel.html')), 'panel window on Wayland', 20000);
    await panel.waitForSelector('.empty');
    const invoke = (channel, payload) => panel.evaluate(([c, p]) => window.memo.invoke(c, p), [channel, payload]);
    const lastMemo = () => panel.locator('.msg.memo').last().innerText();
    const size = await until(() => panel.evaluate(() => (innerWidth > 0 && innerHeight > 0 ? `${innerWidth}x${innerHeight}` : null)), 'the compositor to map the window', 20000).catch(() => panel.evaluate(() => `${innerWidth}x${innerHeight} compact=${document.body.classList.contains('compact')}`));
    console.log(`      window on Wayland: ${size}`);
    const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'MemoBrOS').isVisible());

    await check('native Wayland: the app starts without X11, with no overlay, and says what it cannot do there', async () => {
      const st = await invoke('state:get');
      assert.deepEqual([st.session, st.display], ['wayland', 'wayland'], 'runs natively on Wayland by default on a Wayland session');
      assert.deepEqual([st.caps.overlay, st.caps.control, st.caps.hotkeys], [false, false, 'portal']);
      assert.equal(app.windows().filter((w) => w.url().endsWith('overlay.html')).length, 0, 'no always-on-top overlay window is created');
      assert.match(await app.evaluate(({ app: a }) => a.commandLine.getSwitchValue('enable-features')), /GlobalShortcutsPortal/);
      await panel.click('#tabs [data-tab="settings"]');
      assert.match(await panel.locator('#display-note').innerText(), /Running now: native Wayland\..*not available.*clipboard/);
      const report = await panel.locator('#hotkey-report').innerText();
      assert.match(report, /shortcuts portal/); assert.match(report, /Custom Shortcuts, command:.* --toggle/);
      console.log(`      shortcut registration on this compositor: ${st.hotkeys.failed.length ? `failed for ${st.hotkeys.failed.length} (no portal here), fallback offered` : 'ok'}`);
      assert.ok(await panel.locator('#perm-control').isDisabled(), 'mouse/keyboard permission cannot be switched on where it cannot work');
      assert.match(await panel.locator('#perm-note-text').innerText(), /not available in native Wayland mode\. X11 mode brings both back/, 'and the reason is written right under it');
      assert.ok(await panel.locator('#display-switch').isVisible(), 'with a one-click switch to X11 mode');
      await panel.screenshot({ path: path.join(out, 'desktop-wayland-settings.png') });
      await panel.click('#tabs [data-tab="chat"]');
    });

    await check('native Wayland: show/hide/quit from outside work; agent mode explains itself; dictation falls back to the clipboard', async () => {
      await ctl(env, '--hide'); await until(async () => !(await visible()), '--hide');
      await ctl(env, '--toggle'); await until(async () => visible(), '--toggle');
      api.state.requests.length = 0;
      await panel.click('#modes [data-mode="agent"]'); await panel.fill('#text', 'click the button'); await panel.click('#send');
      await until(async () => (await lastMemo()).includes("can't move the mouse or type in other apps yet"), 'agent mode says why it cannot run');
      assert.equal(api.state.requests.length, 0);
      fs.writeFileSync(t.heardFile, 'hola desde el dictado');
      api.state.script = [() => [text('Hola desde el dictado.')]];
      await panel.evaluate(() => window.memo.invoke('audio:segment', { pcm: new Float32Array(16000).buffer, mode: 'dictate', final: false }));
      await until(async () => (await panel.locator('.msg.dictation').last().innerText()).includes('copied'), 'dictation copied instead of typed');
      // a request that needs the screen either works or fails with a clear message; it must not crash the app
      api.state.script = [() => [text('Screen answer.')]];
      await panel.click('#modes [data-mode="ask"]'); await panel.fill('#text', 'what do you see?'); await panel.click('#send');
      const outcome = await until(async () => ((await lastMemo().catch(() => '')).includes('Screen answer') ? 'captured' : (await panel.locator('.msg.error').last().innerText().catch(() => '')) ? 'explained' : null), 'an answer or a clear error', 20000);
      console.log(`      screen capture on this compositor: ${outcome === 'captured' ? 'worked' : `not available (${(await panel.locator('.msg.error').last().innerText()).slice(0, 90)}…)`}`);
      assert.ok((await invoke('state:get')).display === 'wayland', 'the app is still alive');
      const exited = new Promise((resolve) => app.process().on('exit', resolve));
      await panel.click('#tabs [data-tab="settings"]');
      await panel.click('#display-switch').catch(() => {});
      assert.ok(await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]), 'switching display mode restarts the app');
      assert.equal(JSON.parse(fs.readFileSync(t.settingsFile, 'utf8')).displayBackend, 'x11', 'and the choice is saved');
    });
  } finally {
    if (app) await app.close().catch(() => {});
    weston.kill();
  }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  api = await fake.start();
  try {
    if (process.env.DISPLAY) { await x11Part(); await noMicPart(); } else console.log('SKIP  X11 part (no DISPLAY)');
    await waylandPart();
  } finally { api.close(); }
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
