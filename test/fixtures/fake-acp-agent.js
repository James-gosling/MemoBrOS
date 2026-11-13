// A stand-in for an ACP coding agent (the role Kiro CLI plays): JSON-RPC 2.0 over stdio, one message per line.
// It logs what it is asked to <cwd>/acp-log.jsonl, and asks permission before writing when the task says WRITE.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const waiting = new Map();
let cwd = process.cwd(), nextId = 1000;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) { waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id); return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } });
  if (msg.method === 'session/new') { cwd = msg.params.cwd; fs.appendFileSync(path.join(cwd, 'acp-log.jsonl'), `${JSON.stringify({ session: true, mcpServers: msg.params.mcpServers })}\n`); return reply({ sessionId: `s-${process.pid}` }); }
  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt.map((p) => p.text).join('');
    const name = /You are "([^"]+)"/.exec(text)?.[1] || 'agent';
    fs.appendFileSync(path.join(cwd, 'acp-log.jsonl'), `${JSON.stringify({ name, text })}\n`);
    const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: u } });
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: `Reading the project as ${name}`, kind: 'read', status: 'in_progress' });
    let outcome = 'no write needed';
    if (/(^|Your part:\n)WRITE/.test(text)) { // only when this agent's own task says so
      const res = await ask('session/request_permission', { sessionId: msg.params.sessionId, toolCall: { toolCallId: 't2', title: 'Write api.js', locations: [{ path: path.join(cwd, 'api.js') }] },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
      if (res.outcome.outcome === 'selected' && res.outcome.optionId !== 'no') { fs.writeFileSync(path.join(cwd, 'api.js'), `// written by ${name}\n`); outcome = `wrote api.js (${res.outcome.optionId})`; } else outcome = 'write was refused';
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${name} report: ` } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: outcome } });
    return reply({ stopReason: 'end_turn' });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
});
