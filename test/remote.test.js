// Tests for the remote worker prototype and its client: authentication, the worker's own policy, real execution,
// cancellation. Plain Node; the worker runs in this process on a loopback port.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { start } = require('../src/main/remote/worker');
const client = require('../src/main/remote/client');
const protocol = require('../src/main/remote/protocol');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let w, worker, root;

test('the worker listens on loopback only and answers a health check without revealing anything', async () => {
  assert.match(w.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(w.server.address().address, '127.0.0.1');
  const health = await client.health(worker);
  assert.deepEqual(health, { ok: true, protocol: 2, streaming: true });
  assert.ok(!JSON.stringify(health).includes(os.hostname()), 'no host name, no folders');
  // it cannot be started on a network address at all, and not with a guessable secret
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.com', '']) await assert.rejects(start({ root, port: 0, host }), /only listens on this machine/, host);
  await assert.rejects(start({ root, port: 0, secret: 'short' }), /at least 16 characters/);
  for (const [h, ok] of [['127.0.0.1', true], ['localhost', true], ['::1', true], ['127.0.0.1.evil.com', false], ['10.0.0.1', false]]) assert.equal(protocol.isLoopback(h), ok, h);
});

test('malformed and oversized requests are answered with a clear error, not silence', async () => {
  const post = async (body, headers) => { const r = await fetch(`${w.url}/v1/run`, { method: 'POST', headers, body }); return [r.status, (await r.json()).error]; };
  const signed = (body) => protocol.headers(w.secret, 'POST', '/v1/run', body);
  assert.deepEqual(await post('{not json', signed('{not json')), [400, 'invalid JSON']);
  assert.deepEqual(await post('{"command":["ls"]}', signed('{"command":["ls"]}')), [400, 'command and cwd must be text']);
  const h = signed('{}');
  assert.deepEqual(await post('{}', { ...h, 'x-memobros-timestamp': 'soon' }), [401, 'malformed request']);
  assert.deepEqual(await post('{}', { ...h, 'x-memobros-nonce': 'x' }), [401, 'malformed request']);
  const big = JSON.stringify({ command: 'x'.repeat(120000) });
  assert.deepEqual(await post(big, signed(big)), [413, 'request too large']);
});

test('output is delivered while the command runs, then the real result', async () => {
  const seen = [];
  const started = Date.now();
  const script = "console.log('first');setTimeout(()=>console.error('warn'),300);setTimeout(()=>{console.log('last \u00e1');process.exit(3)},1200)";
  const out = await client.run(worker, { command: `node -e "${script}"`, approved: true, onOutput: (stream, text) => seen.push([stream, text.trim(), Date.now() - started]) });
  assert.deepEqual(seen.map((x) => x.slice(0, 2)), [['stdout', 'first'], ['stderr', 'warn'], ['stdout', 'last á']]);
  assert.ok(seen[0][2] < 900 && seen[2][2] >= 1100, `the first line arrived before the command ended (${seen.map((x) => x[2])})`);
  assert.equal(out.result.exitCode, 3); assert.equal(out.result.stdout, 'first\nlast á\n'); assert.equal(out.decision, 'approved by user');
  // the policy answers are the same with streaming on
  assert.equal((await client.run(worker, { command: 'node -v', onOutput: () => {} })).needsApproval, true);
  await assert.rejects(client.run(worker, { command: 'sudo ls', approved: true, onOutput: () => {} }), (e) => e.denied === true);
  await assert.rejects(client.run({ ...worker, secret: 'wrong-secret-wrong-secret' }, { command: 'hostname', onOutput: () => {} }), /refused the request \(bad signature\)/);
});

test('cancelling a streamed command stops it on the worker, and a job can be stopped by its id', async () => {
  const marker = path.join(root, 'streamed-running');
  const loop = `node -e "setInterval(() => { require('fs').writeFileSync('streamed-running', String(Date.now())); console.log('tick'); }, 100)"`;
  const abort = new AbortController();
  let ticks = 0;
  const pending = client.run(worker, { command: loop, approved: true, signal: abort.signal, onOutput: () => { ticks++; } });
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(ticks >= 3, 'output was arriving');
  abort.abort();
  await assert.rejects(pending, (e) => e.aborted === true);
  await new Promise((r) => setTimeout(r, 2200));
  const before = fs.readFileSync(marker, 'utf8');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'the process on the worker was stopped');
  // POST /v1/cancel: the connection stays open and the worker reports the command as cancelled
  const body = JSON.stringify({ id: 'job-by-id-1', command: loop, approved: true });
  const run = fetch(`${w.url}/v1/run`, { method: 'POST', headers: protocol.headers(w.secret, 'POST', '/v1/run', body), body }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await client.cancel(worker, 'job-by-id-1'), true);
  const done = await run;
  assert.equal(done.id, 'job-by-id-1'); assert.equal(done.result.cancelled, true);
  assert.equal(await client.cancel(worker, 'job-by-id-1'), false, 'nothing left to cancel');
  assert.equal(await client.cancel({ ...worker, secret: 'wrong-secret-wrong-secret' }, 'x'), false, 'cancelling needs the secret too');
});

test('requests must be signed with the shared secret, fresh, and used once', async () => {
  const post = (headers, body) => fetch(`${w.url}/v1/run`, { method: 'POST', headers, body }).then(async (r) => [r.status, (await r.json()).error]);
  const body = JSON.stringify({ command: 'hostname' });
  assert.deepEqual(await post({ 'content-type': 'application/json' }, body), [401, 'unsigned request']);
  assert.deepEqual(await post(protocol.headers('wrong-secret', 'POST', '/v1/run', body), body), [401, 'bad signature']);
  const good = protocol.headers(w.secret, 'POST', '/v1/run', body);
  assert.deepEqual(await post(good, JSON.stringify({ command: 'rm x' })), [401, 'bad signature'], 'a signed request cannot be altered');
  const ts = String(Date.now() - 5 * 60 * 1000);
  assert.deepEqual(await post({ 'content-type': 'application/json', 'x-memobros-timestamp': ts, 'x-memobros-nonce': 'abcdef0123456789abcdef01', 'x-memobros-signature': protocol.sign(w.secret, ts, 'abcdef0123456789abcdef01', 'POST', '/v1/run', body) }, body), [401, 'stale request']);
  assert.equal((await fetch(`${w.url}/v1/run`, { method: 'POST', headers: good, body })).status, 200);
  assert.deepEqual(await post(good, body), [401, 'repeated request'], 'a captured request cannot be replayed');
  await assert.rejects(client.run({ ...worker, secret: 'nope' }, { command: 'ls' }), /refused the request \(bad signature\)\. Check its secret/);
  assert.ok(!JSON.stringify(good).includes(w.secret), 'the secret itself never travels');
});

test('the worker enforces the command policy itself, whatever the control plane claims', async () => {
  await assert.rejects(client.run(worker, { command: 'sudo ls', approved: true }), (e) => e.denied && /never run because it asks for administrator rights/.test(e.message));
  await assert.rejects(client.run(worker, { command: 'rm -rf /', approved: true }), (e) => e.denied === true);
  await assert.rejects(client.run(worker, { command: 'hostname', cwd: '../..', approved: true }), /may only run inside/);
  const ask = await client.run(worker, { command: 'node -e "console.log(1)"' });
  assert.deepEqual([ask.needsApproval, ask.cwd, ask.rule], [true, fs.realpathSync(root), null], 'without approval nothing runs; the worker says what it would need');
});

test('an approved command runs on the worker for real; allow-listed ones need no approval', async () => {
  const done = await client.run(worker, { command: 'node -e "require(\'fs\').writeFileSync(\'made-on-worker.txt\', \'hi\'); console.log(process.cwd())"', approved: true });
  assert.equal(done.decision, 'approved by user'); assert.equal(done.result.exitCode, 0);
  assert.equal(fs.realpathSync(done.result.stdout.trim()), fs.realpathSync(root));
  assert.equal(fs.readFileSync(path.join(root, 'made-on-worker.txt'), 'utf8'), 'hi');
  const listed = await client.run(worker, { command: 'hostname' });
  assert.equal(listed.decision, 'allowed by rule'); assert.equal(listed.result.exitCode, 0); assert.ok(listed.result.stdout.trim().length > 0);
  const failing = await client.run(worker, { command: 'node -e "process.exit(4)"', approved: true });
  assert.equal(failing.result.exitCode, 4, 'failures come back as failures');
});

test('cancelling from the control plane stops the command on the worker', async () => {
  const marker = path.join(root, 'still-running');
  const abort = new AbortController();
  const pending = client.run(worker, { command: `node -e "setInterval(() => require('fs').writeFileSync('still-running', String(Date.now())), 100)"`, approved: true, signal: abort.signal });
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(fs.existsSync(marker));
  abort.abort();
  await assert.rejects(pending, (e) => e.aborted === true);
  await new Promise((r) => setTimeout(r, 2200));
  const before = fs.readFileSync(marker, 'utf8');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'the process on the worker was stopped');
  await assert.rejects(client.run({ name: 'gone', url: 'http://127.0.0.1:9', secret: 'x' }, { command: 'ls' }), /Can't reach the worker "gone"/);
});

(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-root-'));
  w = await start({ root, port: 0, allow: ['hostname'] }); // a program that exists on Linux, macOS and Windows
  worker = { name: 'test-worker', url: w.url, secret: w.secret };
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
  }
  w.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
