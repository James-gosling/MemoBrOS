// Custom tools through the Model Context Protocol: remote servers by URL, local servers by command line.
// Each connected server's tools are offered to the model as mcp__<server>__<tool>.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const store = require('./store');

const live = new Map(); // id → { cfg, sig, client, tools, status: 'connecting' | 'connected' | 'error', error }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'server';

// "npx -y some-server --flag 'two words'" → ['npx', '-y', 'some-server', '--flag', 'two words']
function splitCommand(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line));) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

async function open(cfg) {
  const client = new Client({ name: 'MemoBrOS', version: '0.2.0' });
  if (cfg.type === 'stdio') {
    const [command, ...args] = splitCommand(cfg.command || '');
    if (!command) throw new Error('No command given');
    const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
    await client.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' }));
    return client;
  }
  const url = new URL(cfg.url);
  const token = store.getSecret(`mcp:${cfg.id}`);
  const requestInit = token ? { headers: { Authorization: /^\w+ /.test(token) ? token : `Bearer ${token}` } } : undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
    return client;
  } catch (first) { // older servers only speak the SSE transport
    const legacy = new Client({ name: 'MemoBrOS', version: '0.2.0' });
    try { await legacy.connect(new SSEClientTransport(url, { requestInit })); return legacy; } catch { throw first; }
  }
}

async function connect(cfg) {
  const entry = { cfg, sig: JSON.stringify([cfg.type, cfg.command, cfg.url]), client: null, tools: [], status: 'connecting', error: '' };
  live.set(cfg.id, entry);
  try {
    entry.client = await open(cfg);
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

// Bring live connections in line with settings.mcpServers.
async function sync(force = false) {
  const wanted = store.getSettings().mcpServers.filter((c) => c.enabled !== false);
  for (const id of [...live.keys()]) {
    const cfg = wanted.find((c) => c.id === id);
    if (!cfg || force || live.get(id).sig !== JSON.stringify([cfg.type, cfg.command, cfg.url])) await disconnect(id);
    else live.get(id).cfg = cfg;
  }
  await Promise.all(wanted.filter((c) => !live.has(c.id)).map(connect));
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

module.exports = { sync, tools, forModel, find, preApproved, alwaysAllow, call, status, closeAll, splitCommand };
