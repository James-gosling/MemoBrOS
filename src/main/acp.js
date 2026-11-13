// Agent Client Protocol (ACP) client: MemoBrOS drives an external coding agent such as Kiro CLI
// (`kiro-cli acp`) as a subprocess, speaking JSON-RPC 2.0 over stdio, one JSON message per line.
//
//   MemoBrOS (memory · scheduling · agent coordination · approvals)
//        │  ACP
//   Kiro CLI (code generation · analysis · tests · tool execution)
//        │
//   GitHub · local files · MCP servers
const { spawn } = require('child_process');
const { splitCommand } = require('./mcp');

class AcpAgent {
  // opts: { command, cwd, env, onUpdate(text), onPermission({ title, detail, options }) → optionId | null }
  constructor(opts) {
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.text = '';
    this.buffer = '';
    this.closed = false;
  }

  async start(mcpServers = []) {
    const [command, ...args] = splitCommand(this.opts.command || '');
    if (!command) throw new Error('No coding-agent command is set. Add one in Settings → Coding agent.');
    await new Promise((resolve, reject) => {
      this.child = spawn(command, args, { cwd: this.opts.cwd, env: { ...process.env, ...(this.opts.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
      this.child.once('spawn', resolve);
      this.child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? `"${command}" is not installed or not on PATH.` : e.message)));
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.read(chunk));
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`The coding agent exited${code === null ? '' : ` (code ${code})`} before answering.`));
      this.pending.clear();
    });
    this.child.stdin.on('error', () => {});
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'MemoBrOS', version: '0.4.0' } }, 20000);
    const caps = init.agentCapabilities?.mcpCapabilities || {};
    const servers = mcpServers.filter((s) => !s.type || (s.type === 'http' && caps.http) || (s.type === 'sse' && caps.sse));
    const session = await this.request('session/new', { cwd: this.opts.cwd, mcpServers: servers }, 30000);
    this.sessionId = session.sessionId;
  }

  read(chunk) {
    this.buffer += chunk;
    for (let i; (i = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // not protocol output
      this.handle(msg).catch(() => {});
    }
  }

  async handle(msg) {
    if (msg.method === undefined) { // a response to one of our requests
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'The coding agent reported an error.'));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update || {};
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.text += u.content.text;
      else if (u.sessionUpdate === 'tool_call' && u.title) this.opts.onUpdate?.(u.title);
      else if (u.sessionUpdate === 'plan' && Array.isArray(u.entries)) this.opts.onUpdate?.(`Plan: ${u.entries.map((e) => e.content).join(' · ').slice(0, 160)}`);
      return;
    }
    if (msg.id === undefined) return; // other notifications
    if (msg.method === 'session/request_permission') {
      const { toolCall = {}, options = [] } = msg.params || {};
      let optionId = null;
      try { optionId = await this.opts.onPermission?.({ title: toolCall.title || 'Run a tool', detail: describe(toolCall), options }); } catch { optionId = null; }
      return this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
    }
    // We advertise no file-system or terminal capabilities, so anything else is unsupported.
    return this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `MemoBrOS does not support ${msg.method}` } });
  }

  send(msg) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(msg)}\n`); }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('The coding agent is not running.'));
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`The coding agent did not answer "${method}". Is "${this.opts.command}" an ACP agent, and is it signed in?`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // Sends one prompt turn and resolves with what the agent said.
  async prompt(text, signal) {
    this.text = '';
    const onAbort = () => { this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }); setTimeout(() => this.close(), 1500); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
      return { text: this.text.trim(), stopReason: res.stopReason || 'end_turn' };
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
      throw e;
    } finally { signal?.removeEventListener('abort', onAbort); }
  }

  close() { if (!this.closed) { this.closed = true; try { this.child.kill(); } catch { /* gone */ } } }
}

function describe(toolCall) {
  const lines = [];
  for (const l of toolCall.locations || []) if (l.path) lines.push(l.path);
  if (toolCall.rawInput) lines.push(JSON.stringify(toolCall.rawInput, null, 1).slice(0, 400));
  return lines.join('\n');
}

module.exports = { AcpAgent };
