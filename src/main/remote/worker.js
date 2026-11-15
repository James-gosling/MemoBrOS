#!/usr/bin/env node
// MemoBrOS remote worker (prototype): runs approved commands on another machine on behalf of a MemoBrOS control
// plane. Plain Node, no Electron.
//
//   node src/main/remote/worker.js --root /srv/project [--port 8377] [--host 127.0.0.1] [--allow "git status,npm test"]
//
// The secret comes from MEMOBROS_WORKER_SECRET, or a new one is generated and printed once at start.
// Security model:
//  - It listens on 127.0.0.1 unless told otherwise. It speaks plain HTTP, so reach it over an SSH tunnel or put it
//    behind TLS; do not expose it to a network directly.
//  - Every request must be signed with the shared secret (see protocol.js); unsigned, stale or repeated ones fail.
//  - The worker applies the SAME command policy as the desktop app, with its own folders and allow list. Commands
//    on the never-run list are refused here whatever the control plane says, and commands may only run under --root.
//  - A command that needs approval runs only when the request says the user approved it on the control plane.
//  - Closing the connection (or POST /v1/cancel) stops the command and everything it started.
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const policy = require('../actions/policy');
const executor = require('../actions/executor');
const protocol = require('./protocol');

function start({ root, port = 8377, host = '127.0.0.1', allow = [], secret = process.env.MEMOBROS_WORKER_SECRET || crypto.randomBytes(24).toString('hex'), name = require('os').hostname() }) {
  const roots = [path.resolve(root)];
  const seen = new Set();
  const jobs = new Map(); // id → AbortController
  const send = (res, code, obj) => { if (res.writableEnded) return; res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/health') return send(res, 200, { ok: true, worker: name, protocol: 1 });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      const bad = protocol.verify(secret, req, body, seen);
      if (bad) return send(res, 401, { error: bad });
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      if (req.method === 'POST' && req.url === '/v1/cancel') { jobs.get(msg.id)?.abort(); return send(res, 200, { cancelled: jobs.has(msg.id) }); }
      if (req.method !== 'POST' || req.url !== '/v1/run') return send(res, 404, { error: 'unknown endpoint' });
      const d = policy.decide(msg.command, msg.cwd ? path.resolve(roots[0], msg.cwd) : roots[0], { roots, allow });
      if (d.decision === 'deny') return send(res, 403, { error: d.reason });
      if (d.decision === 'ask' && msg.approved !== true) return send(res, 409, { needsApproval: true, cwd: d.cwd, rule: d.rule, risk: d.risk, shell: d.shell });
      const abort = new AbortController();
      const id = String(msg.id || crypto.randomBytes(6).toString('hex'));
      jobs.set(id, abort);
      res.on('close', () => { if (!res.writableEnded) abort.abort(); }); // the control plane went away: stop
      const r = await executor.run({ ...(d.shell ? { shellLine: msg.command } : { argv: d.argv }), cwd: d.cwd, signal: abort.signal, timeoutMs: Math.min(Number(msg.timeoutSec) || 120, 3600) * 1000 });
      jobs.delete(id);
      send(res, 200, { id, decision: d.decision === 'allow' ? 'allowed by rule' : 'approved by user', result: r });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, secret, url: `http://${host}:${server.address().port}`, close: () => { for (const a of jobs.values()) a.abort(); server.close(); } }));
  });
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const root = arg('root');
  if (!root) { console.error('usage: worker.js --root <folder> [--port 8377] [--host 127.0.0.1] [--allow "git status,npm test"]'); process.exit(2); }
  start({ root, port: Number(arg('port', 8377)), host: arg('host', '127.0.0.1'), allow: String(arg('allow', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) })
    .then((w) => {
      console.log(`MemoBrOS worker listening on ${w.url}, commands confined to ${path.resolve(root)}`);
      if (!process.env.MEMOBROS_WORKER_SECRET) console.log(`Secret (enter it in MemoBrOS → Settings → Remote workers; shown only now): ${w.secret}`);
    })
    .catch((e) => { console.error(`Could not start: ${e.message}`); process.exit(1); });
}

module.exports = { start };
