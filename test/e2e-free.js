// End-to-end test of the zero-cost provider path and the routines / MCP / upload features.
// The app runs with its default provider (OpenRouter, OpenAI chat format) pointed at a scripted fake.
const fs = require('fs');
const os = require('os');
const http = require('http');
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
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-free-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-shared-'));
  fs.writeFileSync(path.join(shared, 'invoice-march.pdf'), 'PDF-BYTES-OF-THE-INVOICE');
  const outside = path.join(userData, 'secret.txt');
  fs.writeFileSync(outside, 'do not upload');
  const marker = path.join(userData, 'deleted.log');
  const api = await fake.start();

  // A web form that accepts an upload, and a minimal remote MCP server (streamable HTTP, JSON responses).
  const uploads = [];
  const site = await listen((req, res) => {
    if (req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { uploads.push(b); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Thanks, received.</h1>'); }); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Expenses</title><h1>Submit an expense</h1><form method="post" action="/submit" enctype="multipart/form-data"><label>Receipt <input type="file" name="receipt"></label><input name="note" placeholder="Note"><button type="submit">Send expense</button></form><form method="get" action="/"><input name="q" placeholder="Search"><button type="submit">Search</button></form>');
  });
  const remoteCalls = [];
  const remote = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const msg = JSON.parse(b);
      remoteCalls.push({ method: msg.method, auth: req.headers.authorization });
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }
          : msg.method === 'tools/call' ? { content: [{ type: 'text', text: `Sunny in ${msg.params.arguments.city}` }] } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });

  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ providers: { openrouter: { baseUrl: `${api.url}/api/v1` } }, sharedFolders: [shared], speak: false }));
  const app = await _electron.launch({
    executablePath: require('electron'), args: [root, '--no-sandbox'],
    env: { ...process.env, OPENROUTER_API_KEY: 'or-test-key', ANTHROPIC_API_KEY: '', MEMOBROS_USER_DATA: userData, MEMOBROS_TEST: '1' },
  });
  const results = [];
  const check = async (name, fn) => {
    api.state.requests.length = 0; api.state.script = [];
    try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); }
    catch (e) {
      results.push([name, 'FAIL']);
      console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 3).join(' | ')}`);
      const p = app.windows().find((w) => w.url().endsWith('panel.html'));
      if (p) console.log('      last panel messages:', await p.locator('.msg').allInnerTexts().then((a) => a.slice(-4)).catch(() => []), `| API requests: ${api.state.requests.length}`);
    }
  };

  try {
    const byFile = (f) => app.windows().find((w) => w.url().endsWith(f));
    const panel = await until(() => byFile('panel.html'), 'panel window');
    const overlay = await until(() => byFile('overlay.html'), 'overlay window');
    await panel.waitForSelector('.empty');
    const main = (fn, arg) => app.evaluate(fn, arg);
    const invoke = (channel, payload) => panel.evaluate(([c, p]) => window.memo.invoke(c, p), [channel, payload]);
    const send = async (mode, message) => { await panel.click('#tabs [data-tab="chat"]'); await panel.click(`#modes [data-mode="${mode}"]`); await panel.fill('#text', message); await panel.click('#send'); };
    const lastMemo = () => panel.locator('.msg.memo').last().innerText();
    const confirmTitle = async () => ((await panel.locator('#confirm').isHidden()) ? '' : panel.locator('#confirm-title').innerText());
    const routinesNow = async () => (await invoke('state:get')).routines;

    await main(({ BrowserWindow }) => {
      const w = new BrowserWindow({ x: 80, y: 80, width: 640, height: 420, frame: false, title: 'scratch' });
      w.loadURL('data:text/html,<body style="margin:0"><textarea id="t" style="width:100%;height:100%;font-size:20px" autofocus></textarea></body>');
    });
    const scratch = await until(() => app.windows().find((w) => w.url().startsWith('data:')), 'scratch window');

    await check('free provider: default is OpenRouter free; ask works through the OpenAI chat format', async () => {
      const st = await invoke('state:get');
      assert.equal(st.llm.provider, 'openrouter'); assert.equal(st.llm.model, 'openrouter/free'); assert.ok(st.hasKey);
      api.state.script = [() => [use('point', { x: 400, y: 300, label: 'Here' })], () => [text('<think>hmm</think>Click right here.')]];
      await send('ask', 'where do I click?');
      await until(async () => (await lastMemo()) === 'Click right here.', 'reply with inline reasoning stripped');
      const [r1, r2] = api.state.requests;
      assert.equal(r1.url, '/api/v1/chat/completions');
      assert.equal(r1.headers.authorization, 'Bearer or-test-key');
      assert.equal(r1.body.model, 'openrouter/free');
      assert.equal(r1.body.messages[0].role, 'system');
      const user = r1.body.messages.at(-1);
      assert.ok(user.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')), 'screenshot as image_url');
      assert.ok(r1.body.tools.every((t) => t.type === 'function' && t.function.parameters), 'tools in function format');
      assert.ok(r1.body.tools.some((t) => t.function.name === 'create_routine'));
      const tail = r2.body.messages.slice(-2);
      assert.equal(tail[0].role, 'assistant'); assert.equal(tail[0].tool_calls[0].function.name, 'point');
      assert.equal(tail[1].role, 'tool'); assert.equal(tail[1].tool_call_id, tail[0].tool_calls[0].id);
      await until(() => overlay.evaluate(() => document.getElementById('label').textContent === 'Here'), 'pointer label');
      const models = await invoke('models:list', { provider: 'openrouter' });
      assert.equal(models[0].id, 'free/vision-tools:free', 'free + vision + tools ranked first');
      assert.ok(!models[2].free);
    });

    await check('agent on a free model, then chat-to-routine in one click', async () => {
      api.state.script = [
        () => [text('1. Click the text area\n2. Type hello')],
        () => [use('click', { x: 400, y: 290 }), use('type', { text: 'hello' })],
        () => [use('done', { summary: 'Typed hello.' })],
      ];
      await send('agent', 'type hello in the text area');
      await panel.waitForSelector('#confirm:not([hidden])');
      await panel.click('#confirm-yes');
      await until(async () => (await lastMemo()).includes('Typed hello.'), 'agent summary', 30000);
      assert.equal(await scratch.evaluate(() => document.getElementById('t').value), 'hello');
      const loop = api.state.requests[2].body.messages;
      assert.ok(loop.some((m) => m.role === 'tool') && loop.at(-1).role === 'user' && loop.at(-1).content.some((p) => p.type === 'image_url'), 'after-action screenshot follows the tool results');
      await panel.click('.make-routine');
      await panel.waitForSelector('#routine-form:not([hidden])');
      const [r] = await routinesNow();
      assert.equal(r.task, 'type hello in the text area'); assert.ok(r.desktop && r.enabled);
      assert.match(r.cron, /^\d+ \d+ \* \* \*$/); assert.match(r.scheduleText, /^Every day at/); assert.match(r.plan, /Click the text area/);
      assert.equal(await panel.locator('#routine-task').inputValue(), 'type hello in the text area');
      await panel.screenshot({ path: path.join(out, 'panel-routine-from-chat.png') });
      // change its schedule in plain words through the editor
      api.state.script = [() => [text('{"name":"x","task":"x","cron":"30 9 * * 1-5","run_once_at":null,"schedule_text":"Every weekday at 9:30 AM","needs_screen":true}')]];
      await panel.fill('#routine-when', 'every weekday at 9:30 am');
      await panel.click('#routine-form button[type=submit]');
      await until(async () => (await routinesNow())[0].cron === '30 9 * * 1-5', 'schedule updated from plain words');
      await invoke('routine:delete', { id: r.id });
    });

    await check('natural-language scheduling: spoken sentence → recurring routine (no cron written by the user)', async () => {
      api.state.script = [() => [text('```json\n{"name":"Invoice check","task":"Check my inbox for invoices and tell me what arrived","cron":"0 17 * * 2","run_once_at":null,"schedule_text":"Every Tuesday at 5:00 PM","needs_screen":false}\n```')]];
      await main(() => global.__memo.route('Every Tuesday at 5 PM, check my inbox for invoices', 'ask'));
      await until(async () => (await lastMemo()).includes('Invoice check'), 'spoken confirmation');
      assert.ok(!JSON.stringify(api.state.requests[0].body).includes('image_url'), 'scheduling sends no screenshot');
      const r = (await routinesNow()).find((x) => x.name === 'Invoice check');
      assert.equal(r.cron, '0 17 * * 2'); assert.equal(r.desktop, false);
      const next = new Date(r.nextRun);
      assert.equal(next.getDay(), 2); assert.equal(next.getHours(), 17); assert.ok(next > new Date());
      // the model can also create one from an ordinary request through the create_routine tool
      api.state.script = [() => [use('create_routine', { name: 'Stand-up notes', task: 'Open my notes', cron: '45 8 * * 1-5', schedule_text: 'Weekdays at 8:45', needs_screen: true })], () => [text('Listo.')]];
      await send('ask', 'remind me to open my notes before stand-up on weekdays');
      await until(async () => (await routinesNow()).some((x) => x.name === 'Stand-up notes'), 'routine from tool call');
      // a draft without a usable schedule is refused rather than saved
      api.state.script = [() => [text('{"name":"Vague","task":"do things","cron":null,"run_once_at":null,"schedule_text":"","needs_screen":false}')]];
      await panel.click('#tabs [data-tab="routines"]');
      await panel.fill('#routine-text', 'check stuff sometimes');
      await panel.click('#routine-new button');
      await until(async () => (await panel.locator('#routine-note').innerText()).includes("couldn't work out when"), 'schedule error shown');
      assert.equal((await routinesNow()).length, 2);
      await panel.screenshot({ path: path.join(out, 'panel-routines.png') });
    });

    await check('custom MCP: local command + remote URL connect; read-only tool runs by voice, changing tool asks first', async () => {
      let st = await invoke('mcp:save', { server: { name: 'Sales DB', type: 'stdio', command: `node "${path.join(__dirname, 'fixtures', 'mcp-stdio.js')}" "${marker}"` } });
      st = await invoke('mcp:save', { server: { name: 'Weather', type: 'http', url: `${remote.url}/mcp` }, token: 'tok-123' });
      const [db, weather] = st.mcp;
      assert.equal(db.status, 'connected', db.error); assert.deepEqual(db.tools, ['query_db', 'delete_row']);
      assert.equal(weather.status, 'connected', weather.error); assert.deepEqual(weather.tools, ['get_weather']);
      assert.ok(remoteCalls.every((c) => c.auth === 'Bearer tok-123'), 'token sent to the remote server');
      assert.ok(!fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').includes('tok-123'), 'token not stored in settings.json');

      api.state.script = [() => [use('mcp__sales_db__query_db', { sql: 'select * from sales' }), use('mcp__weather__get_weather', { city: 'CDMX' })], () => [text('ACME bought 1234.')]];
      await send('ask', 'what did ACME buy?');
      await until(async () => (await lastMemo()).includes('ACME bought 1234'), 'answer from tool data');
      assert.ok(api.state.requests[0].body.tools.some((t) => t.function.name === 'mcp__sales_db__delete_row'));
      const toolMsgs = api.state.requests[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      assert.match(toolMsgs[0], /"customer":"ACME"/); assert.match(toolMsgs[1], /Sunny in CDMX/);

      api.state.script = [() => [use('mcp__sales_db__delete_row', { id: 7 })], () => [text('Okay, left it alone.')]];
      await send('ask', 'delete row 7');
      await until(async () => (await confirmTitle()).includes('wants to use Sales DB'), 'approval card for a changing tool');
      assert.ok(!fs.existsSync(marker), 'nothing deleted before approval');
      await panel.screenshot({ path: path.join(out, 'panel-mcp-approval.png') });
      await panel.click('#confirm-no');
      await until(async () => (await lastMemo()).includes('left it alone'), 'reply after denial');
      assert.ok(!fs.existsSync(marker), 'denied tool did not run');
      assert.match(api.state.requests.at(-1).body.messages.at(-1).content, /did not approve/);

      api.state.script = [() => [use('mcp__sales_db__delete_row', { id: 7 })], () => [text('Deleted.')]];
      await send('ask', 'yes really delete row 7');
      await until(async () => (await confirmTitle()).includes('wants to use Sales DB'), 'approval card');
      await panel.click('#confirm-always');
      await until(async () => (await lastMemo()).includes('Deleted.'), 'reply after approval');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'deleted 7\n');
      api.state.script = [() => [use('mcp__sales_db__delete_row', { id: 8 })], () => [text('Deleted 8.')]];
      await send('ask', 'and row 8');
      await until(async () => (await lastMemo()).includes('Deleted 8.'), '"always allow" skips the card next time');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'deleted 7\ndeleted 8\n');
    });

    let expenseId;
    await check('background routine: reads a web form, uploads a local file only after one-time approval, pauses before submitting', async () => {
      const file = path.join(shared, 'invoice-march.pdf');
      api.state.script = [() => [text(JSON.stringify({ name: 'File expenses', task: `Upload my latest invoice at ${site.url}/`, cron: '0 9 1 * *', schedule_text: 'On the 1st of each month at 9 AM', needs_screen: false }))]];
      expenseId = (await invoke('routine:create', { text: 'On the 1st of each month at 9 AM, upload my latest invoice to the expenses site' })).routines.at(-1).id;
      api.state.requests.length = 0;
      const mouseBefore = await main(({ screen }) => screen.getCursorScreenPoint());
      api.state.script = [
        () => [use('browser_open', { url: `${site.url}/` })],
        () => [use('list_files', { query: 'invoice' })],
        () => [use('browser_upload', { id: 0, path: outside })],           // outside the shared folders: must be refused
        () => [use('browser_upload', { id: 0, path: file })],              // needs the one-time approval
        () => [use('browser_type', { id: 1, text: 'March invoice' }), use('browser_click', { id: 2 })], // submit: needs approval
        () => [text('Uploaded invoice-march.pdf and sent the expense.')],
      ];
      await invoke('routine:run', { id: expenseId });
      await until(async () => (await confirmTitle()).startsWith('Upload a file to'), 'upload approval card');
      assert.match(await panel.locator('#confirm-text').innerText(), /invoice-march\.pdf[\s\S]*asked once per file and site/);
      assert.equal(uploads.length, 0);
      await panel.screenshot({ path: path.join(out, 'panel-upload-approval.png') });
      await panel.click('#confirm-yes');
      await until(async () => (await confirmTitle()).includes('wants to submit a form'), 'submit approval card');
      assert.match(await panel.locator('#confirm-text').innerText(), /Send expense/);
      assert.equal(uploads.length, 0, 'form not submitted before approval');
      await panel.click('#confirm-yes');
      await until(async () => (await routinesNow()).find((r) => r.id === expenseId).lastRun, 'routine finished');
      const r = (await routinesNow()).find((x) => x.id === expenseId);
      assert.equal(r.lastRun.status, 'ok'); assert.match(r.lastRun.summary, /sent the expense/);
      assert.equal(uploads.length, 1);
      assert.match(uploads[0], /filename="invoice-march\.pdf"[\s\S]*PDF-BYTES-OF-THE-INVOICE/); assert.match(uploads[0], /March invoice/);
      const reqs = api.state.requests;
      assert.ok(!JSON.stringify(reqs[0].body).includes('image_url'), 'background routines send no screenshots');
      assert.match(reqs[1].body.messages.at(-1).content, /\[0\] input:file[\s\S]*\[2\] button "Send expense"/);
      assert.match(reqs[2].body.messages.at(-1).content, /invoice-march\.pdf/);
      assert.match(reqs[3].body.messages.at(-1).content, /outside the folders shared/);
      assert.deepEqual(await main(({ screen }) => screen.getCursorScreenPoint()), mouseBefore, 'the mouse was never touched');
      assert.ok((await lastMemo()).includes('sent the expense'), 'report shown in the panel');

      // second run: the same file on the same site needs no new upload approval; "always" then covers the submit too
      api.state.script = [
        () => [use('browser_open', { url: `${site.url}/` })],
        () => [use('browser_upload', { id: 0, path: file })],
        () => [use('browser_click', { id: 2 })],
        () => [text('Sent again.')],
      ];
      await invoke('routine:run', { id: expenseId });
      await until(async () => await confirmTitle(), 'a card appears');
      assert.ok((await confirmTitle()).includes('wants to submit a form'), 'upload was not asked again');
      await panel.click('#confirm-always');
      await until(() => uploads.length === 2, 'second upload sent');
      await until(async () => !(await routinesNow()).find((x) => x.id === expenseId).running, 'run finished');
      api.state.script = [() => [use('browser_open', { url: `${site.url}/` })], () => [use('browser_upload', { id: 0, path: file })], () => [use('browser_click', { id: 2 })], () => [text('Third time, no questions.')]];
      await invoke('routine:run', { id: expenseId });
      await until(() => uploads.length === 3, 'third run needs no approval at all');
    });

    await check('guardrails: a declined upload sends nothing; request_approval pauses the routine', async () => {
      await until(async () => !(await routinesNow()).find((x) => x.id === expenseId).running, 'previous run finished');
      fs.writeFileSync(path.join(shared, 'payroll.csv'), 'salaries');
      const before = uploads.length;
      api.state.script = [
        () => [use('browser_open', { url: `${site.url}/` })],
        () => [use('browser_upload', { id: 0, path: path.join(shared, 'payroll.csv') })],
        () => [use('request_approval', { question: 'Email the summary to finance?' })],
        () => [text('Nothing was uploaded or sent.')],
      ];
      await invoke('routine:run', { id: expenseId });
      await until(async () => (await confirmTitle()).startsWith('Upload a file to'), 'upload approval for a new file');
      await panel.click('#confirm-no');
      await until(async () => (await confirmTitle()).includes('needs your OK'), 'request_approval card');
      assert.equal(await panel.locator('#confirm-text').innerText(), 'Email the summary to finance?');
      await panel.click('#confirm-no');
      await until(async () => (await routinesNow()).find((x) => x.id === expenseId).lastRun.summary.includes('Nothing was uploaded'), 'routine finished');
      assert.equal(uploads.length, before);
      const results = api.state.requests.at(-1).body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      assert.match(results.at(-2), /did not approve/); assert.match(results.at(-1), /did not approve/);
      assert.ok(!fs.readFileSync(path.join(userData, 'grants.json'), 'utf8').includes('payroll'));
    });

    await check('scheduler: a due routine fires on its own, a one-off retires, state survives on disk', async () => {
      api.state.script = [() => [text(JSON.stringify({ name: 'One-off', task: 'Say hi', cron: null, run_once_at: new Date(Date.now() + 1500).toISOString(), schedule_text: 'In a moment', needs_screen: false }))]];
      const id = (await invoke('routine:create', { text: 'in a moment say hi' })).routines.at(-1).id;
      api.state.script = [() => [text('Hi! Nothing needs your attention.')]];
      await sleep(1800);
      await main(() => global.__memo.routines.tick());
      await until(async () => (await routinesNow()).find((x) => x.id === id).lastRun, 'scheduled run happened');
      const r = (await routinesNow()).find((x) => x.id === id);
      assert.equal(r.lastRun.summary, 'Hi! Nothing needs your attention.'); assert.equal(r.enabled, false); assert.equal(r.nextRun, null);
      const disk = JSON.parse(fs.readFileSync(path.join(userData, 'routines.json'), 'utf8'));
      assert.equal(disk.length, 4); assert.ok(disk.find((x) => x.id === expenseId).allowed.some((k) => k.startsWith('submit:')));
      const paused = await invoke('routine:toggle', { id: expenseId, enabled: false });
      assert.equal(paused.routines.find((x) => x.id === expenseId).nextRun, null);
    });

    await check('OmniRoute: switching provider routes requests to the local gateway with model "auto"', async () => {
      const st = await invoke('settings:save', { settings: { provider: 'omniroute', providers: { omniroute: { baseUrl: `${api.url}/v1` } } }, omnirouteKey: 'omni-key' });
      assert.equal(st.llm.provider, 'omniroute'); assert.equal(st.llm.model, 'auto');
      api.state.script = [() => [text('Hola desde OmniRoute.')]];
      await send('ask', 'hola');
      await until(async () => (await lastMemo()).includes('Hola desde OmniRoute'), 'reply');
      const r = api.state.requests[0];
      assert.equal(r.url, '/v1/chat/completions'); assert.equal(r.body.model, 'auto'); assert.equal(r.headers.authorization, 'Bearer omni-key');
      assert.ok(!r.body.plugins);
    });
  } finally {
    await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
    await app.close().catch(() => {});
    api.close(); site.server.close(); remote.server.close();
  }
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
