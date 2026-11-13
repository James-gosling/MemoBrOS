// A stand-in for an ACP coding agent (the role Kiro CLI plays): JSON-RPC 2.0 over stdio, one message per line.
// Tests install it as an executable called `kiro-cli`; like the real one it only serves ACP when given `acp`.
// It logs to $ACP_LOG and follows simple directives in its own task ("Your part:" section):
//   WRITE            ask permission, then write api.js
//   PUT <file> <text> write a file in its working directory
//   CRASH            exit without answering (after any PUTs)
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.ACP_LOG || path.join(process.cwd(), 'acp-log.jsonl'), `${JSON.stringify({ pid: process.pid, t: Date.now(), ...entry })}\n`);
if (!args.includes('acp')) { process.stderr.write('usage: kiro-cli acp\n'); log({ refused: args }); process.exit(2); }

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waiting = new Map();
let cwd = process.cwd(), nextId = 1000;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) { waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id); return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } });
  if (msg.method === 'session/new') { cwd = msg.params.cwd; log({ session: true, args, cwd, processCwd: process.cwd(), mcpServers: msg.params.mcpServers }); return reply({ sessionId: `s-${process.pid}` }); }
  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt.map((p) => p.text).join('');
    const name = /You are "([^"]+)"/.exec(text)?.[1] || 'agent';
    const own = /Your part:\n([\s\S]*?)\n\nThe other agents/.exec(text)?.[1] || text;
    log({ name, start: true, cwd, text });
    const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: u } });
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: `Reading the project as ${name}`, kind: 'read', status: 'in_progress' });
    await sleep(250);
    const did = [];
    for (const m of own.matchAll(/^PUT (\S+) (.*)$/gm)) { fs.mkdirSync(path.dirname(path.join(cwd, m[1])), { recursive: true }); fs.writeFileSync(path.join(cwd, m[1]), `${m[2]}\n`); did.push(`put ${m[1]}`); }
    if (/^CRASH$/m.test(own)) { log({ name, crashed: true }); process.exit(3); }
    if (/^WRITE/m.test(own)) {
      const res = await ask('session/request_permission', { sessionId: msg.params.sessionId, toolCall: { toolCallId: 't2', title: 'Write api.js', locations: [{ path: path.join(cwd, 'api.js') }] },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
      if (res.outcome.outcome === 'selected' && res.outcome.optionId !== 'no') { fs.writeFileSync(path.join(cwd, 'api.js'), `// written by ${name}\n`); did.push(`wrote api.js (${res.outcome.optionId})`); } else did.push('write was refused');
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${name} report: ` } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: did.join(', ') || 'no write needed' } });
    log({ name, end: true });
    return reply({ stopReason: 'end_turn' });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
});
