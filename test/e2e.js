// End-to-end test: launches the real app against a scripted fake Claude API and drives all five abilities.
// Run with a display:  xvfb-run -a -s "-screen 0 1280x800x24" node test/e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { _electron } = require('playwright');
const fake = require('./fakeLLM');
const { text, use } = fake;

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(150);
  }
}

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-test-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ provider: 'anthropic', permissions: { screen: true, microphone: true, control: true } })); // this suite covers the Claude path; e2e-free.js covers the free providers
  const api = await fake.start();
  const app = await _electron.launch({
    executablePath: process.env.MEMOBROS_BIN || require('electron'), // MEMOBROS_BIN: test a packaged build instead
    args: [...(process.env.MEMOBROS_BIN ? [] : [root]), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'test-key', MEMOBROS_USER_DATA: userData, MEMOBROS_TEST: '1', MEMOBROS_FAKE_TRANSCRIPT: 'hola mundo como estas' },
  });
  const results = [];
  const check = async (name, fn) => {
    api.state.requests.length = 0;
    try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); }
    catch (e) {
      results.push([name, 'FAIL']);
      console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0]}`);
      const p = app.windows().find((w) => w.url().endsWith('panel.html'));
      if (p) console.log('      last panel messages:', await p.locator('.msg').allInnerTexts().then((a) => a.slice(-4)).catch(() => []), `| API requests: ${api.state.requests.length}`);
    }
  };

  try {
    await until(() => app.windows().length >= 2, 'both windows');
    const byFile = (f) => app.windows().find((w) => w.url().endsWith(f));
    const panel = await until(() => byFile('panel.html'), 'panel window');
    const overlay = await until(() => byFile('overlay.html'), 'overlay window');
    await panel.waitForSelector('.empty');
    const main = (fn, arg) => app.evaluate(fn, arg);
    const send = async (mode, message) => {
      await panel.click(`#modes [data-mode="${mode}"]`);
      await panel.fill('#text', message);
      await panel.click('#send');
    };
    const lastMemo = () => panel.locator('.msg.memo').last().innerText();

    // A scratch window standing in for "the user's app".
    await main(({ BrowserWindow }) => {
      const w = new BrowserWindow({ x: 80, y: 80, width: 640, height: 420, frame: false, title: 'scratch' });
      w.loadURL('data:text/html,<body style="margin:0"><textarea id="t" style="width:100%;height:100%;font-size:20px" autofocus></textarea></body>');
      global.__scratch = w;
    });
    const scratch = await until(() => app.windows().find((w) => w.url().startsWith('data:')), 'scratch window');
    const scratchText = () => scratch.evaluate(() => document.getElementById('t').value);

    await check('1+2 ask: screenshot goes to Claude, cursor points, annotations are drawn, answer is shown', async () => {
      api.state.script = [
        () => [text('Mira aquí.'), use('point', { x: 400, y: 300, label: 'Text area' }), use('draw', { shapes: [{ type: 'circle', x: 300, y: 200, x2: 500, y2: 400, label: 'Type here' }, { type: 'arrow', x: 700, y: 500, x2: 520, y2: 380 }] })],
        () => [text('Escribe en este cuadro.')],
      ];
      await send('ask', 'where do I type?');
      await until(async () => (await lastMemo()).includes('Escribe en este cuadro'), 'spoken reply in panel');
      const first = api.state.requests[0];
      assert.ok(first.url.startsWith('/v1/messages'), `unexpected url ${first.url}`);
      assert.match(first.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
      assert.equal(first.body.fallbacks, 'default');
      assert.equal(first.body.model, 'claude-opus-5-5');
      const content = first.body.messages.at(-1).content;
      const image = content.find((b) => b.type === 'image');
      assert.ok(image && image.source.data.length > 5000, 'screenshot attached');
      assert.ok(first.body.tools.some((t) => t.name === 'point') && first.body.tools.some((t) => t.name === 'draw'));
      assert.match(first.body.system, /1280x800/);
      assert.equal(api.state.requests[1].body.messages.at(-1).content.filter((b) => b.type === 'tool_result').length, 2);
      await until(() => overlay.evaluate(() => document.getElementById('label').classList.contains('on') && document.getElementById('label').textContent === 'Text area'), 'pointer label');
      assert.ok(await overlay.evaluate(() => document.querySelectorAll('#ink path.stroke').length === 2 && document.querySelectorAll('#ink polygon').length === 1 && document.querySelector('#ink text').textContent === 'Type here'), 'annotations in overlay');
      await sleep(1100);
      const b = await overlay.evaluate(() => document.getElementById('buddy').getBoundingClientRect().toJSON());
      assert.ok(Math.abs(b.x - 400) < 8 && Math.abs(b.y - 300) < 8, `buddy flew to target (at ${b.x},${b.y})`);
      assert.ok(await overlay.evaluate(() => document.getElementById('caption').textContent.includes('Escribe')), 'caption');
      await overlay.screenshot({ path: path.join(out, 'overlay-ask.png') });
      await panel.screenshot({ path: path.join(out, 'panel-ask.png') });
    });

    await check('5 skills + memory + attachments: skill body is served, note is remembered, file is sent', async () => {
      const file = path.join(userData, 'notes.txt');
      fs.writeFileSync(file, 'The invoice total is 1,234 MXN.');
      await panel.evaluate((p) => window.memo.invoke('attach:add', { paths: [p] }), file);
      api.state.script = [
        () => [use('use_skill', { name: 'Summarize attachment' }), use('remember', { note: 'Prefers answers in Spanish' })],
        () => [text('El total es 1,234 MXN.')],
      ];
      await send('ask', 'what does my file say?');
      await until(async () => (await lastMemo()).includes('1,234 MXN'), 'reply');
      const [r1, r2] = api.state.requests;
      const doc = r1.body.messages.at(-1).content.find((b) => b.type === 'document');
      assert.ok(doc && doc.source.data.includes('1,234 MXN'), 'attachment sent as a document block');
      assert.match(r1.body.system, /Figma walkthrough/);
      const toolResults = r2.body.messages.at(-1).content;
      assert.match(JSON.stringify(toolResults[0].content), /Quote numbers and names exactly/);
      const st = await panel.evaluate(() => window.memo.invoke('state:get'));
      assert.ok(st.memory.some((m) => m.note === 'Prefers answers in Spanish'));
      assert.equal(st.skills.length, 4);
      await panel.evaluate((p) => window.memo.invoke('attach:remove', { path: p }), file);
      // skill CRUD + pin
      let s2 = await panel.evaluate(() => window.memo.invoke('skill:save', { name: 'Reply in pirate', description: 'test', body: 'Arr.' }));
      assert.ok(s2.skills.some((s) => s.id === 'reply-in-pirate'));
      s2 = await panel.evaluate(() => window.memo.invoke('skill:pin', { id: 'reply-in-pirate' }));
      api.state.script = [() => [text('Arr!')]];
      await send('ask', 'hello');
      await until(async () => (await lastMemo()).includes('Arr!'), 'reply');
      assert.match(api.state.requests.at(-1).body.system, /pinned the skill "Reply in pirate"[\s\S]*Arr\./);
      assert.match(api.state.requests.at(-1).body.system, /Prefers answers in Spanish/);
      await panel.evaluate(() => window.memo.invoke('skill:delete', { id: 'reply-in-pirate' }));
    });

    await check('5 walkthrough: steps card, per-step pointing, next/finish', async () => {
      api.state.script = [
        () => [use('start_walkthrough', { title: 'Export a frame', steps: ['Select the frame', 'Open the Export section', 'Click Export'] })],
        () => [text('Vamos paso a paso.')],
        () => [use('point', { x: 200, y: 150, label: 'Frame' })],
        () => [text('Haz clic en el marco.')],
      ];
      await send('ask', 'walk me through exporting a frame in Figma');
      await until(async () => (await lastMemo()).includes('Haz clic en el marco'), 'step 1 reply');
      assert.equal(await panel.locator('#walk-steps li').count(), 3);
      assert.equal(await panel.locator('#walk-count').innerText(), '1 / 3');
      assert.match(JSON.stringify(api.state.requests[2].body.messages.at(-1).content), /step 1 of 3: Select the frame/);
      api.state.script = [() => [use('point', { x: 900, y: 600, label: 'Export' })], () => [text('Ahora abre Exportar.')]];
      await panel.click('#walk-next');
      await until(async () => (await lastMemo()).includes('Ahora abre Exportar'), 'step 2 reply');
      assert.equal(await panel.locator('#walk-count').innerText(), '2 / 3');
      await panel.screenshot({ path: path.join(out, 'panel-walkthrough.png') });
      api.state.script = [() => [text('Último paso.')]];
      await panel.click('#walk-next');
      await until(async () => (await lastMemo()).includes('Último paso'), 'step 3 reply');
      await panel.click('#walk-next');
      await until(() => panel.locator('#walk').isHidden(), 'walkthrough card closed');
    });

    await check('3 agent: plan → approval → real click + typing in another window → summary', async () => {
      api.state.script = [
        () => [text('1. Click the text area\n2. Type the greeting')],
        () => [text('Clicking the text area.'), use('click', { x: 400, y: 290, why: 'focus the text area' }), use('type', { text: '¡Hola desde MemoBrOS!' })],
        () => [use('key', { combo: 'enter' }), use('type', { text: 'second line' })],
        () => [use('done', { summary: 'Listo, escribí el saludo.' })],
      ];
      await send('agent', 'type a greeting in the text area');
      await panel.waitForSelector('#confirm:not([hidden])');
      assert.match(await panel.locator('#confirm-text').innerText(), /Click the text area/);
      await panel.screenshot({ path: path.join(out, 'panel-agent-confirm.png') });
      assert.equal(await scratchText(), '', 'nothing typed before approval');
      await panel.click('#confirm-yes');
      await until(async () => (await lastMemo()).includes('Listo, escribí el saludo'), 'agent summary', 30000);
      assert.equal(await scratchText(), '¡Hola desde MemoBrOS!\nsecond line');
      const follow = api.state.requests[2].body.messages.at(-1).content;
      assert.ok(follow.at(-1).content.some((b) => b.type === 'image'), 'fresh screenshot returned after actions');
      assert.equal(api.state.requests[1].body.output_config.effort, 'medium');
    });

    await check('3 agent: declining the plan touches nothing', async () => {
      await scratch.evaluate(() => { document.getElementById('t').value = ''; });
      api.state.script = [() => [text('1. Delete everything')]];
      await send('ask', 'memo agent, delete everything');
      await panel.waitForSelector('#confirm:not([hidden])');
      await panel.click('#confirm-no');
      await until(async () => (await lastMemo()).includes("won't touch"), 'cancel message');
      assert.equal(api.state.requests.length, 1, 'no agent loop request after decline');
    });

    await check('4 dictation: mic → transcript → grammar polish → typed into the focused field of another app', async () => {
      await scratch.evaluate(() => { const t = document.getElementById('t'); t.value = ''; t.focus(); });
      await main(() => global.__memo.input.click({ x: 400, y: 290 })); // put the caret in the other app, like a user would
      api.state.script = [() => [text('Hola mundo, ¿cómo estás?')]];
      await main(() => global.__memo.toggleListen('dictate'));
      await until(() => overlay.evaluate(() => document.getElementById('buddy').dataset.status === 'dictating'), 'dictating state');
      await sleep(2000); // the fake microphone beeps continuously, so end the segment the way a user would: with the hotkey
      await main(() => global.__memo.toggleListen('dictate'));
      await until(async () => (await scratchText()).includes('Hola mundo, ¿cómo estás?'), 'dictated text typed', 20000);
      const polish = api.state.requests[0].body;
      assert.match(polish.system, /dictated speech/);
      assert.equal(polish.messages[0].content, 'hola mundo como estas');
      await sleep(1500);
      api.state.script = [];
    });

    await check('2 voice ask: hotkey toggle → mic → transcript → screen-aware answer', async () => {
      await sleep(1000);
      api.state.requests.length = 0;
      api.state.script = [() => [text('Estoy bien, gracias.')]];
      await main(() => global.__memo.toggleListen('ask'));
      await until(() => overlay.evaluate(() => document.getElementById('buddy').dataset.status === 'listening'), 'listening state');
      await sleep(2200);
      await main(() => global.__memo.toggleListen('ask'));
      await until(async () => (await lastMemo()).includes('Estoy bien'), 'answer to voice question');
      assert.ok(await panel.locator('.msg.user').last().innerText() === 'hola mundo como estas');
      assert.ok(api.state.requests[0].body.messages.at(-1).content.some((b) => b.type === 'image'));
    });

    await check('settings: key + hotkeys persist, hotkeys all registered', async () => {
      const res = await panel.evaluate(() => window.memo.invoke('settings:save', { settings: { language: 'es', confirmEachAction: true }, anthropicKey: 'sk-test' }));
      assert.deepEqual(res.failedHotkeys, []);
      assert.equal(res.settings.language, 'es');
      assert.ok(res.hasKey);
      assert.ok(!fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').includes('sk-test'), 'key is not in settings.json');
    });

    await check('3 agent: per-action confirmation mode asks before each action', async () => {
      await scratch.evaluate(() => { document.getElementById('t').value = ''; });
      api.state.script = [
        () => [text('1. Type ok')],
        () => [use('click', { x: 400, y: 290 })],
        () => [use('done', { summary: 'Hecho.' })],
      ];
      await send('agent', 'click the text area');
      await panel.waitForSelector('#confirm:not([hidden])');
      await panel.click('#confirm-yes');
      await until(async () => (await panel.locator('#confirm-title').innerText()) === 'Next action' && !(await panel.locator('#confirm').isHidden()), 'per-action confirm');
      await main(() => global.__memo.resolveConfirm(true));
      await until(async () => (await lastMemo()).includes('Hecho'), 'summary');
    });
  } finally {
    await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
    await app.close().catch(() => {});
    api.close();
  }
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
