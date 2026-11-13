// Custom tools through the Model Context Protocol: remote servers by URL, local servers by command line.
// Each connected server's tools are offered to the model as mcp__<server>__<tool>.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const http = require('http');
const { shell } = require('electron');
const store = require('./store');

// ---- OAuth sign-in for remote servers (Notion, Figma, …) ------------------------------
// The server sends the user to its sign-in page in their normal browser; the result comes back to a
// loopback address on this machine. Tokens are kept with the other secrets (OS keychain encryption).
const OAUTH_PORT = 38917;
const REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`;
let signInQueue = Promise.resolve(); // one browser sign-in at a time (they share the callback port)

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<body style="font-family:system-ui;text-align:center;padding-top:15vh"><h2>MemoBrOS is connected.</h2><p>You can close this tab.</p></body>');
      clearTimeout(timer); server.close();
      const code = u.searchParams.get('code');
      if (code) resolve(code); else reject(new Error(`Sign-in was not completed (${u.searchParams.get('error') || 'no code returned'}).`));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out. Press Retry to try again.')); }, 5 * 60 * 1000);
    server.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not listen for the sign-in result: ${e.message}`)); });
    server.listen(OAUTH_PORT, '127.0.0.1');
  });
}

function oauthProvider(cfg, interactive) {
  const key = `mcpauth:${cfg.id}`;
  const load = () => { try { return JSON.parse(store.getSecret(key) || '{}'); } catch { return {}; } };
  const save = (patch) => store.setSecret(key, JSON.stringify({ ...load(), ...patch }));
  const provider = {
    code: null, // promise for the authorization code once the browser has been opened
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() { return { client_name: 'MemoBrOS', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    clientInformation: () => load().client,
    saveClientInformation: (client) => save({ client }),
    tokens: () => load().tokens,
    saveTokens: (tokens) => save({ tokens }),
    saveCodeVerifier: (verifier) => save({ verifier }),
    codeVerifier: () => load().verifier,
    redirectToAuthorization: (url) => {
      if (!interactive) throw new Error('Sign-in needed. Press Retry to sign in.'); // never pop a browser at startup
      provider.code = waitForCallback();
      provider.code.catch(() => {});
      if (process.env.MEMOBROS_TEST) fetch(url).catch(() => {}); // tests: follow the redirect instead of opening a browser
      else shell.openExternal(String(url));
    },
  };
  return provider;
}

// "KEY=value" lines → { KEY: 'value' }
const parseEnv = (text) => Object.fromEntries(String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]));

const live = new Map(); // id → { cfg, sig, client, tools, status: 'connecting' | 'connected' | 'error', error }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'server';

// "npx -y some-server --flag 'two words'" → ['npx', '-y', 'some-server', '--flag', 'two words']
function splitCommand(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line));) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

async function open(cfg, interactive) {
  const newClient = () => new Client({ name: 'MemoBrOS', version: '0.3.0' });
  if (cfg.type === 'stdio') {
    const [command, ...args] = splitCommand(cfg.command || '');
    if (!command) throw new Error('No command given');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), ...parseEnv(store.getSecret(`mcpenv:${cfg.id}`)) };
    const client = newClient();
    try { await client.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' })); }
    catch (e) { throw new Error(e.code === 'ENOENT' ? `"${command}" is not installed or not on PATH.` : e.message); }
    return client;
  }
  const url = new URL(cfg.url);
  const token = store.getSecret(`mcp:${cfg.id}`);
  if (token) { // a pasted access token (e.g. a GitHub personal access token)
    const requestInit = { headers: { Authorization: /^\w+ /.test(token) ? token : `Bearer ${token}` } };
    const client = newClient();
    try { await client.connect(new StreamableHTTPClientTransport(url, { requestInit })); return client; }
    catch (first) { // older servers only speak the SSE transport
      const legacy = newClient();
      try { await legacy.connect(new SSEClientTransport(url, { requestInit })); return legacy; } catch { throw first; }
    }
  }
  // No token: connect directly, and if the server asks for it, sign in through the browser (OAuth).
  const provider = oauthProvider(cfg, interactive);
  const attempt = async () => {
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    const client = newClient();
    try { await client.connect(transport); return client; }
    catch (e) {
      if (!(e instanceof UnauthorizedError) || !provider.code) throw e;
      await transport.finishAuth(await provider.code); // the user signed in; trade the code for tokens
      const signedIn = newClient();
      await signedIn.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
      return signedIn;
    }
  };
  if (!interactive) return attempt();
  const run = signInQueue.then(attempt);
  signInQueue = run.catch(() => {});
  return run;
}

async function connect(cfg, interactive) {
  const entry = { cfg, sig: JSON.stringify([cfg.type, cfg.command, cfg.url]), client: null, tools: [], status: 'connecting', error: '' };
  live.set(cfg.id, entry);
  try {
    entry.client = await open(cfg, interactive);
    entry.tools = (await entry.client.listTools()).tools || [];
    entry.status = 'connected';
  } catch (e) {
    entry.status = 'error';
    entry.error = String(e.message || e).slice(0, 300);
  }
}
async function disconnect(id) {
  const e = live.get(id);
  live.delete(id);
  try { await e?.client?.close(); } catch { /* already gone */ }
}

// Bring live connections in line with settings.mcpServers. `interactive` allows opening a browser to sign in;
// `force` reconnects everything, or just the server with that id.
async function sync(force = false, interactive = false) {
  const wanted = store.getSettings().mcpServers.filter((c) => c.enabled !== false);
  for (const id of [...live.keys()]) {
    const cfg = wanted.find((c) => c.id === id);
    if (!cfg || force === true || force === id || live.get(id).status === 'error' || live.get(id).sig !== JSON.stringify([cfg.type, cfg.command, cfg.url])) await disconnect(id);
    else live.get(id).cfg = cfg;
  }
  await Promise.all(wanted.filter((c) => !live.has(c.id)).map((c) => connect(c, interactive && (force === true || force === c.id))));
}

// Tool definitions for the model, plus what the guardrails need to know about each.
function tools() {
  const out = [];
  for (const e of live.values()) {
    if (e.status !== 'connected') continue;
    for (const t of e.tools) {
      out.push({
        name: `mcp__${slug(e.cfg.name)}__${t.name}`.slice(0, 64),
        description: `[${e.cfg.name}] ${t.description || t.name}`.slice(0, 1000),
        input_schema: t.inputSchema || { type: 'object', properties: {} },
        serverId: e.cfg.id, serverName: e.cfg.name, tool: t.name,
        readOnly: t.annotations?.readOnlyHint === true,
      });
    }
  }
  return out;
}
const forModel = () => tools().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
const find = (name) => tools().find((t) => t.name === name);

// May this tool run without asking? Read-only tools, trusted servers and tools the user chose "always allow" for.
function preApproved(t) {
  const cfg = store.getSettings().mcpServers.find((c) => c.id === t.serverId) || {};
  return t.readOnly || cfg.trust === 'always' || (cfg.allowedTools || []).includes(t.tool);
}
function alwaysAllow(t) {
  const servers = store.getSettings().mcpServers.map((c) => (c.id === t.serverId ? { ...c, allowedTools: [...new Set([...(c.allowedTools || []), t.tool])] } : c));
  store.saveSettings({ mcpServers: servers });
}

async function call(name, args) {
  const t = find(name);
  if (!t) throw new Error(`No connected tool named ${name}`);
  const res = await live.get(t.serverId).client.callTool({ name: t.tool, arguments: args || {} });
  const text = (res.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text || '' : `[${c.type} content]`)).join('\n').trim()
    || (res.structuredContent ? JSON.stringify(res.structuredContent) : 'Done.');
  if (res.isError) throw new Error(text.slice(0, 2000));
  return text.slice(0, 20000);
}

const status = () => store.getSettings().mcpServers.map((c) => {
  const e = live.get(c.id);
  return { id: c.id, status: c.enabled === false ? 'off' : e?.status || 'connecting', error: e?.error || '', tools: (e?.tools || []).map((t) => t.name) };
});
const closeAll = () => Promise.all([...live.keys()].map(disconnect));

module.exports = { parseEnv, sync, tools, forModel, find, preApproved, alwaysAllow, call, status, closeAll, splitCommand };
