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

  // A remote MCP server that requires OAuth sign-in (the way Notion's and Figma's do).
  const oauthLog = [];
  const oauth = await listen((req, res) => {
    const base = `http://${req.headers.host}`;
    const u = new URL(req.url, base);
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      oauthLog.push(`${req.method} ${u.pathname}`);
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (u.pathname === '/register') return json(201, { ...JSON.parse(b), client_id: 'client-1' });
      if (u.pathname === '/authorize') { res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=code-1&state=${u.searchParams.get('state') || ''}` }); return res.end(); }
      if (u.pathname === '/token') return json(200, { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
      if (u.pathname === '/mcp' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer access-1') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        const msg = JSON.parse(b);
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'workspace', version: '1' } }
          : msg.method === 'tools/list' ? { tools: [{ name: 'search_pages', description: 'Search the workspace', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }
            : { content: [{ type: 'text', text: 'Found: Q4 roadmap' }] };
        return json(200, { jsonrpc: '2.0', id: msg.id, result });
      }
      res.writeHead(404); res.end();
    });
  });

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-project-'));
  // Stand-ins installed as real executables on PATH: `kiro-cli` (an ACP agent) and `kirocrew` (a gateway that is NOT one).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-bin-'));
  const acpLogFile = path.join(userData, 'acp-log.jsonl'), gatewayLog = path.join(userData, 'kirocrew');
  const script = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`); fs.chmodSync(file, 0o755); };
  script(path.join(bin, 'kiro-cli'), `exec node "${path.join(__dirname, 'fixtures', 'fake-acp-agent.js')}" "$@"`);
  script(path.join(bin, 'kirocrew'), `echo "$@" > "${gatewayLog}.argv"\ncat > "${gatewayLog}.stdin"\nexec sleep 300`);
  const acpLog = () => (fs.existsSync(acpLogFile) ? fs.readFileSync(acpLogFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const git = (cwd, ...a) => require('child_process').execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ permissions: { screen: true, microphone: true, control: true }, codeAgent: { cwd: project }, providers: { openrouter: { baseUrl: `${api.url}/api/v1` } }, sharedFolders: [shared], speak: false }));
  const app = await _electron.launch({
    executablePath: process.env.MEMOBROS_BIN || require('electron'), args: [...(process.env.MEMOBROS_BIN ? [] : [root]), '--no-sandbox'],
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ACP_LOG: acpLogFile, OPENROUTER_API_KEY: 'or-test-key', ANTHROPIC_API_KEY: '', MEMOBROS_USER_DATA: userData, MEMOBROS_TEST: '1' },
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
      let st = await invoke('mcp:save', { server: { name: 'Sales DB', type: 'stdio', command: `node "${path.join(__dirname, 'fixtures', 'mcp-stdio.js')}" "${marker}"`, env: 'MEMO_FIXTURE_ENV=from-settings' } });
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
      assert.match(toolMsgs[0], /"customer":"ACME"/); assert.match(toolMsgs[0], /env=from-settings/, 'per-server environment reaches a local MCP server'); assert.match(toolMsgs[1], /Sunny in CDMX/);

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

    await check('connectors: a remote MCP server that needs browser sign-in (OAuth) connects and stays signed in', async () => {
      let st = await invoke('mcp:save', { server: { name: 'Workspace', type: 'http', url: `${oauth.url}/mcp` } });
      const ws = st.mcp.find((m) => m.id === st.settings.mcpServers.find((c) => c.name === 'Workspace').id);
      assert.equal(ws.status, 'connected', ws.error); assert.deepEqual(ws.tools, ['search_pages']);
      for (const step of ['POST /register', 'GET /authorize', 'POST /token']) assert.ok(oauthLog.includes(step), `OAuth step ${step}`);
      const secrets = fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8');
      assert.ok(/mcpauth:/.test(secrets), 'tokens kept with the secrets'); assert.ok(!fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').includes('access-1'));
      api.state.script = [() => [use('mcp__workspace__search_pages', { q: 'roadmap' })], () => [text('It is the Q4 roadmap.')]];
      await send('ask', 'find the roadmap page');
      await until(async () => (await lastMemo()).includes('Q4 roadmap'), 'answer from the signed-in server');
      oauthLog.length = 0;
      st = await invoke('mcp:reconnect', {}); // reconnecting reuses the saved token: no new sign-in
      assert.equal(st.mcp.find((m) => m.id === ws.id).status, 'connected');
      assert.ok(!oauthLog.includes('GET /authorize'), 'no second sign-in');
      // presets and account shortcuts are offered in the UI
      await panel.click('#tabs [data-tab="settings"]');
      assert.deepEqual(await panel.locator('#mcp-presets b').allInnerTexts(), ['Notion', 'GitHub', 'Google Workspace', 'Figma', 'Figma desktop', 'Vercel', 'Airtable', 'Supabase', 'Companio', 'Claude', 'ChatGPT']);
      const setUp = (name) => panel.locator('#mcp-presets .item', { has: panel.locator(`b:text-is("${name}")`) }).locator('button').click();
      await setUp('Companio');
      assert.equal(await panel.locator('#mcp-url').inputValue(), 'https://companio-api.byafluence.com/mcp');
      for (const [n, u] of [['Vercel', 'https://mcp.vercel.com'], ['Airtable', 'https://mcp.airtable.com/mcp'], ['Supabase', 'https://mcp.supabase.com/mcp']]) { await setUp(n); assert.equal(await panel.locator('#mcp-url').inputValue(), u); }
      await setUp('Google Workspace');
      assert.equal(await panel.locator('#mcp-command').inputValue(), 'uvx workspace-mcp --tool-tier core');
      assert.match(await panel.locator('#mcp-env').inputValue(), /GOOGLE_OAUTH_CLIENT_ID=/);
      await setUp('Notion');
      assert.equal(await panel.locator('#mcp-url').inputValue(), 'https://mcp.notion.com/mcp');
      await panel.locator('#mcp-presets').scrollIntoViewIfNeeded();
      await panel.screenshot({ path: path.join(out, 'panel-connectors.png') });
      await panel.click('#tabs [data-tab="routines"]');
      assert.ok((await panel.locator('#account-links button').allInnerTexts()).includes('Google account'));
    });

    await check('background task by voice: runs in the hidden browser, reports back, screen untouched', async () => {
      api.state.script = [
        () => [use('run_in_background', { task: `Open ${site.url}/ and tell me the page title` })],
        () => [text('On it, I will let you know.')],
        () => [use('browser_open', { url: `${site.url}/` })],
        () => [text('The page is titled Expenses.')],
      ];
      await send('ask', 'check the expenses site for me');
      await until(async () => (await lastMemo()).includes('titled Expenses'), 'background report in the panel');
      assert.ok(api.state.requests[0].body.tools.some((t) => t.function.name === 'run_in_background'));
      assert.ok(!JSON.stringify(api.state.requests[2].body).includes('image_url'));
      const ua = await main(() => global.__memo.web.window.webContents.getUserAgent());
      assert.ok(/Chrome\//.test(ua) && !/Electron|memobros/i.test(ua), `background browser presents as plain Chrome (${ua})`);
      assert.ok(await overlay.evaluate(() => { const i = document.querySelector('#buddy img'); return i.complete && i.naturalWidth === 256; }), 'custom cursor image is shown');
      await overlay.screenshot({ path: path.join(out, 'overlay-cursor.png') });
    });

    await check('crew: orchestrator splits the goal between subagents; Kiro-style coders run over ACP with approvals; results are merged', async () => {
      api.state.script = [
        () => [text(JSON.stringify({ agents: [
          { name: 'Backend', kind: 'coder', phase: 1, task: 'WRITE the API module' },
          { name: 'Docs scout', kind: 'researcher', phase: 1, task: `Read ${site.url}/ and note the page title` },
          { name: 'Reviewer', kind: 'coder', phase: 2, task: 'Review what Backend built' },
        ] }))],
        () => [use('browser_open', { url: `${site.url}/` })],
        () => [text('The docs page is titled Expenses.')],
        () => [text('The crew built the API module and reviewed it.')],
      ];
      await send('crew', 'build the expenses API and check the docs');
      await until(async () => (await confirmTitle()).includes('Backend wants to: Write api.js'), 'approval card for the coding agent');
      assert.equal(await panel.locator('#crew-agents .agent').count(), 3);
      assert.ok(!fs.existsSync(path.join(project, 'api.js')), 'nothing written before approval');
      await panel.screenshot({ path: path.join(out, 'panel-crew.png') });
      await panel.click('#confirm-yes');
      await until(async () => (await lastMemo()).includes('built the API module and reviewed it'), 'crew report', 30000);
      assert.equal(fs.readFileSync(path.join(project, 'api.js'), 'utf8'), '// written by Backend\n');
      assert.equal(await panel.locator('#crew-count').innerText(), '3 / 3 done');
      const log = acpLog();
      const sessions = log.filter((l) => l.session);
      assert.equal(sessions.length, 2, 'one ACP session per coder');
      assert.equal((await invoke('state:get')).codeAgent.command, 'kiro-cli acp', 'Kiro CLI is the default coding agent');
      assert.ok(sessions.every((x) => JSON.stringify(x.args) === '["acp"]'), 'started as the kiro-cli executable with the single argument acp');
      assert.ok(sessions.every((x) => x.cwd === project && fs.realpathSync(x.processCwd) === fs.realpathSync(project)));
      assert.ok(sessions[0].mcpServers.some((m) => m.name === 'Sales DB' && m.command === 'node'), 'local MCP servers are handed to the coding agent');
      assert.ok(sessions[0].mcpServers.some((m) => m.name === 'Weather' && m.headers[0].value === 'Bearer tok-123'), 'token-based remote servers too');
      assert.ok(!sessions[0].mcpServers.some((m) => m.name === 'Workspace'), 'browser-sign-in servers are not handed over');
      const review = log.find((l) => l.name === 'Reviewer' && l.start).text;
      assert.match(review, /Backend report: wrote api\.js \(yes\)/, 'phase-2 agent sees phase-1 results');
      assert.match(review, /The docs page is titled Expenses/);
      const synth = api.state.requests.at(-1).body.messages.at(-1).content;
      assert.match(synth, /## Reviewer \(coder\) — done/); assert.match(synth, /## Docs scout \(researcher\) — done/);
      assert.match(api.state.requests[0].body.messages[0].content, /two to four subagents[\s\S]*"coder"[\s\S]*"researcher"/);

      // the 2–4 rule: one planned agent gets a reviewer added, six are cut to four; by voice prefix and via the model's tool
      api.state.script = [() => [text('{"agents":[{"name":"Solo","kind":"coder","phase":1,"task":"tidy the readme"}]}')], () => [text('Tidied and checked.')]];
      await main(() => global.__memo.route('memo crew, tidy the readme', 'ask'));
      await until(async () => (await lastMemo()).includes('Tidied and checked'), 'second crew report', 30000);
      assert.deepEqual(await panel.locator('#crew-agents b').allInnerTexts(), ['Solo', 'Reviewer']);
      api.state.script = [
        () => [use('start_crew', { goal: 'refactor everything' })], () => [text('Starting the crew.')],
        () => [text(JSON.stringify({ agents: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `A${n}`, kind: 'coder', phase: 1, task: `part ${n}` })) }))], () => [text('All four parts done.')],
      ];
      await send('ask', 'refactor everything with the crew');
      await until(async () => (await lastMemo()).includes('All four parts done'), 'third crew report', 30000);
      assert.equal(await panel.locator('#crew-agents .agent').count(), 4);
      // this project has no Git, so worktrees are unavailable: the four coders must take turns in the one folder
      const spans = ['A1', 'A2', 'A3', 'A4'].map((n) => ({ n, s: acpLog().find((l) => l.name === n && l.start), e: acpLog().find((l) => l.name === n && l.end) }));
      assert.ok(spans.every((x) => x.s && x.e && x.s.cwd === project), 'all four ran in the project folder');
      spans.sort((a, b) => a.s.t - b.s.t);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i].s.t >= spans[i - 1].e.t, `${spans[i].n} started only after ${spans[i - 1].n} finished (sequential fallback)`);
      assert.match(api.state.requests.at(-1).body.messages.at(-1).content, /one at a time directly in the project folder, because the project folder is not a Git repository/);

      // a refused permission is reported, and a missing coding agent fails that subagent without sinking the rest
      fs.rmSync(path.join(project, 'api.js'));
      api.state.script = [() => [text('{"agents":[{"name":"Writer","kind":"coder","phase":1,"task":"WRITE again"},{"name":"Checker","kind":"coder","phase":2,"task":"check"}]}')], () => [text('Nothing was written.')]];
      await send('crew', 'write it again');
      await until(async () => (await confirmTitle()).includes('Writer wants to'), 'approval card');
      await panel.click('#confirm-no');
      await until(async () => (await lastMemo()).includes('Nothing was written'), 'report after refusal', 30000);
      assert.ok(!fs.existsSync(path.join(project, 'api.js')));
      assert.match(acpLog().filter((l) => l.name === 'Checker' && l.start).at(-1).text, /write was refused/);
      await invoke('settings:save', { settings: { codeAgent: { command: 'definitely-not-installed-agent acp' } } });
      api.state.script = [() => [text(JSON.stringify({ agents: [{ name: 'Coder', kind: 'coder', phase: 1, task: 'code' }, { name: 'Scout', kind: 'researcher', phase: 1, task: 'look' }] }))], () => [text('Scout found it.')], () => [text('The coder could not start; the scout finished.')]];
      await send('crew', 'try with a broken agent');
      await until(async () => (await lastMemo()).includes('coder could not start'), 'report with a failed subagent', 30000);
      assert.match(api.state.requests.at(-1).body.messages.at(-1).content, /## Coder \(coder\) — failed\n"definitely-not-installed-agent" is not installed/);
      // an absolute executable path (with a space in it) works too
      const abs = path.join(bin, 'my tools', 'kiro-cli');
      script(abs, `exec node "${path.join(__dirname, 'fixtures', 'fake-acp-agent.js')}" "$@"`);
      await invoke('settings:save', { settings: { codeAgent: { command: `"${abs}" acp` } } });
      const before = acpLog().filter((l) => l.session).length;
      api.state.script = [() => [text('{"agents":[{"name":"Abs","kind":"coder","phase":1,"task":"look"},{"name":"Abs2","kind":"coder","phase":2,"task":"check"}]}')], () => [text('Absolute path worked.')]];
      await send('crew', 'use the absolute path');
      await until(async () => (await lastMemo()).includes('Absolute path worked'), 'report', 30000);
      assert.equal(acpLog().filter((l) => l.session).length, before + 2);
      await invoke('settings:save', { settings: { codeAgent: { command: 'kiro-cli acp' } } });
    });

    await check('Kiro Crew is a gateway, not an ACP agent: started only on request with `kirocrew gateway`, never spoken ACP to, never given crew work', async () => {
      let st = await invoke('state:get');
      assert.equal(st.settings.crewGateway.command, 'kirocrew gateway');
      assert.equal(st.gateway.state, 'stopped', 'the gateway is not started automatically');
      assert.ok(!fs.existsSync(`${gatewayLog}.argv`));
      assert.ok(!('crewCommand' in st.settings.codeAgent) && !('crewCommand' in st.codeAgent), 'there is no Kiro Crew ACP command setting');
      await invoke('gateway:start');
      await until(async () => (await invoke('state:get')).gateway.state === 'running', 'gateway running');
      await until(() => fs.existsSync(`${gatewayLog}.stdin`), 'gateway process started');
      assert.equal(fs.readFileSync(`${gatewayLog}.argv`, 'utf8').trim(), 'gateway');
      // a crew run while the gateway is up: MemoBrOS still plans it itself and the coders are still kiro-cli
      const sessionsBefore = acpLog().filter((l) => l.session).length;
      api.state.requests.length = 0;
      api.state.script = [() => [text('{"agents":[{"name":"G1","kind":"coder","phase":1,"task":"look"},{"name":"G2","kind":"coder","phase":2,"task":"check"}]}')], () => [text('Done with the gateway running.')]];
      await send('crew', 'work while the gateway runs');
      await until(async () => (await lastMemo()).includes('Done with the gateway running'), 'report', 30000);
      assert.match(api.state.requests[0].body.messages[0].content, /orchestrator of a small crew/, 'MemoBrOS did the orchestration');
      assert.equal(acpLog().filter((l) => l.session).length, sessionsBefore + 2, 'both coders were kiro-cli ACP sessions');
      assert.equal(fs.readFileSync(`${gatewayLog}.stdin`, 'utf8'), '', 'nothing (no ACP handshake, no task) was written to the gateway');
      assert.ok(!acpLog().some((l) => l.refused), 'no ACP agent was ever started with gateway arguments');
      await invoke('gateway:stop');
      await until(async () => (await invoke('state:get')).gateway.state === 'stopped', 'gateway stopped');
      st = await invoke('settings:save', { settings: { crewGateway: { command: 'no-such-gateway-binary gateway' } } });
      await invoke('gateway:start');
      await until(async () => /not installed or not on PATH/.test((await invoke('state:get')).gateway.detail), 'a missing gateway is reported, not fatal');
      await invoke('settings:save', { settings: { crewGateway: { command: 'kirocrew gateway' } } });
    });

    await check('worktree isolation: parallel coders get separate worktrees; failures and conflicts stay contained; merge needs approval; history and local changes survive', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-repo-'));
      git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Tester'); git(repo, 'config', 'user.email', 't@example.com');
      fs.writeFileSync(path.join(repo, 'shared.txt'), 'original\n'); fs.writeFileSync(path.join(repo, 'readme.md'), 'readme\n');
      git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'first commit');
      fs.writeFileSync(path.join(repo, 'old.txt'), 'old\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'second commit');
      const history = git(repo, 'log', '--topo-order', '--format=%H %s'), base = git(repo, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, 'readme.md'), 'readme with my unsaved edit\n');   // the user's uncommitted change
      fs.writeFileSync(path.join(repo, 'scratch-notes.txt'), 'untracked notes\n');        // and an untracked file
      await invoke('settings:save', { settings: { codeAgent: { cwd: repo } } });
      const from = acpLog().length;
      api.state.requests.length = 0;
      api.state.script = [
        () => [text(JSON.stringify({ agents: [
          { name: 'Alpha', kind: 'coder', phase: 1, task: 'PUT src/alpha.js alpha code\nPUT shared.txt alpha version' },
          { name: 'Beta', kind: 'coder', phase: 1, task: 'PUT src/beta.js beta code\nPUT shared.txt beta version' },
          { name: 'Gamma', kind: 'coder', phase: 1, task: 'PUT src/gamma.js half written\nPUT src/alpha.js gamma trampling alpha\nCRASH' },
          { name: 'Delta', kind: 'coder', phase: 1, task: 'PUT .env.production SECRET=1\nPUT src/delta.js delta code' },
        ] }))],
        () => [text('Alpha is merged; Beta conflicted, Gamma failed and Delta was held back.')],
      ];
      await send('crew', 'build four modules');
      await until(async () => (await confirmTitle()) === "Merge the crew's work into main?", 'merge approval card', 40000);
      // --- before approval: nothing has reached the project
      assert.equal(git(repo, 'rev-parse', 'HEAD'), base, 'main has not moved before approval');
      assert.ok(!fs.existsSync(path.join(repo, 'src')), 'no agent wrote into the project folder');
      const card = await panel.locator('#confirm-text').innerText();
      assert.match(card, /Alpha changed 2 files/); assert.match(card, /src\/alpha\.js/); assert.match(card, /Not included: Beta \(conflict[^)]*\), Gamma \(not integrated\), Delta \(held back\)/);
      await panel.screenshot({ path: path.join(out, 'panel-merge-approval.png') });
      // --- each coder ran in its own worktree, at the same time
      const log = acpLog().slice(from);
      const starts = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((n) => log.find((l) => l.name === n && l.start));
      assert.equal(new Set(starts.map((x) => x.cwd)).size, 4, 'four different working directories');
      assert.ok(starts.every((x) => fs.realpathSync(path.dirname(x.cwd)) !== fs.realpathSync(repo) && !x.cwd.startsWith(repo)), 'none of them is inside the project folder');
      const firstEnd = Math.min(...['Alpha', 'Beta', 'Delta'].map((n) => log.find((l) => l.name === n && l.end).t));
      assert.ok(starts.every((x) => x.t < firstEnd), 'they overlapped in time (parallel), which is only safe because the directories differ');
      const branches = git(repo, 'branch', '--format=%(refname:short)').split('\n');
      const branchOf = (n) => branches.find((b) => b.startsWith('memobros/') && b.endsWith(n));
      for (const n of ['1-alpha', '2-beta', '3-gamma', '4-delta', 'integration']) assert.ok(branchOf(n), `branch for ${n} exists`);
      // --- a failed agent cannot overwrite another agent's work
      assert.equal(git(repo, 'show', `${branchOf('integration')}:src/alpha.js`), 'alpha code', "Alpha's file is exactly what Alpha wrote");
      assert.equal(git(repo, 'show', `${branchOf('3-gamma')}:src/alpha.js`), 'gamma trampling alpha', "Gamma's stray write stayed on Gamma's own branch");
      assert.equal(git(repo, 'show', `${branchOf('3-gamma')}:src/gamma.js`), 'half written', "the failed agent's partial work is preserved, not discarded");
      assert.throws(() => git(repo, 'show', `${branchOf('integration')}:src/gamma.js`), 'nothing from the failed agent was integrated');
      // --- conflicts are detected before integration; protected files are held back
      assert.equal(git(repo, 'show', `${branchOf('integration')}:shared.txt`), 'alpha version');
      assert.equal(git(repo, 'show', `${branchOf('2-beta')}:shared.txt`), 'beta version', 'the conflicting work is kept on its branch');
      assert.throws(() => git(repo, 'show', `${branchOf('integration')}:src/beta.js`));
      assert.throws(() => git(repo, 'show', `${branchOf('integration')}:.env.production`), 'the protected file never reached the integration branch');
      // --- approve: fast-forward only
      await panel.click('#confirm-yes');
      await until(async () => (await lastMemo()).includes('Alpha is merged'), 'crew report', 30000);
      assert.equal(fs.readFileSync(path.join(repo, 'src', 'alpha.js'), 'utf8'), 'alpha code\n');
      assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'alpha version\n');
      assert.ok(!fs.existsSync(path.join(repo, 'src', 'beta.js')) && !fs.existsSync(path.join(repo, 'src', 'gamma.js')) && !fs.existsSync(path.join(repo, '.env.production')));
      // --- existing files and history are intact
      assert.equal(fs.readFileSync(path.join(repo, 'readme.md'), 'utf8'), 'readme with my unsaved edit\n', "the user's uncommitted edit survived");
      assert.equal(fs.readFileSync(path.join(repo, 'scratch-notes.txt'), 'utf8'), 'untracked notes\n', "the user's untracked file survived");
      assert.equal(fs.readFileSync(path.join(repo, 'old.txt'), 'utf8'), 'old\n');
      assert.ok(git(repo, 'log', '--topo-order', '--format=%H %s').endsWith(history), 'every earlier commit is still there, in order');
      assert.equal(git(repo, 'merge-base', 'HEAD', base), base, 'main only moved forward');
      require('child_process').execFileSync('git', ['fsck', '--no-progress'], { cwd: repo });
      const notes = api.state.requests.at(-1).body.messages.at(-1).content;
      assert.match(notes, /Beta: conflict with earlier work in shared\.txt/); assert.match(notes, /Gamma: not integrated: the agent failed\. Its partial work is on branch/);
      assert.match(notes, /Delta: held back: it changed protected files \(\.env\.production\)/); assert.match(notes, /Merged into main \(2 files\)/);

      // declining the merge leaves main alone and keeps the work on its branch
      const head2 = git(repo, 'rev-parse', 'HEAD');
      api.state.script = [() => [text('{"agents":[{"name":"Epsilon","kind":"coder","phase":1,"task":"PUT src/eps.js eps"},{"name":"Zeta","kind":"coder","phase":2,"task":"PUT src/zeta.js zeta"}]}')], () => [text('Left on a branch.')]];
      await send('crew', 'two more modules');
      await until(async () => (await confirmTitle()) === "Merge the crew's work into main?", 'second merge approval', 40000);
      await panel.click('#confirm-no');
      await until(async () => (await lastMemo()).includes('Left on a branch'), 'report', 30000);
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head2); assert.ok(!fs.existsSync(path.join(repo, 'src', 'eps.js')));
      const integ = git(repo, 'branch', '--format=%(refname:short)').split('\n').filter((b) => b.endsWith('/integration')).at(-1);
      assert.equal(git(repo, 'show', `${integ}:src/eps.js`), 'eps'); assert.equal(git(repo, 'show', `${integ}:src/zeta.js`), 'zeta', 'the phase-2 agent built on the integrated phase-1 work');
      assert.match(api.state.requests.at(-1).body.messages.at(-1).content, /You did not approve the merge/);
      await invoke('settings:save', { settings: { codeAgent: { cwd: project } } });
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
      assert.equal(disk.length, 4, 'one-off background tasks are not saved as routines'); assert.ok(disk.find((x) => x.id === expenseId).allowed.some((k) => k.startsWith('submit:')));
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
    api.close(); site.server.close(); remote.server.close(); oauth.server.close();
  }
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
