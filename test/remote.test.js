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
  assert.deepEqual(Object.keys(await client.health(worker)).sort(), ['ok', 'protocol', 'worker']);
});

test('requests must be signed with the shared secret, fresh, and used once', async () => {
  const post = (headers, body) => fetch(`${w.url}/v1/run`, { method: 'POST', headers, body }).then(async (r) => [r.status, (await r.json()).error]);
  const body = JSON.stringify({ command: 'hostname' });
  assert.deepEqual(await post({ 'content-type': 'application/json' }, body), [401, 'unsigned request']);
  assert.deepEqual(await post(protocol.headers('wrong-secret', 'POST', '/v1/run', body), body), [401, 'bad signature']);
  const good = protocol.headers(w.secret, 'POST', '/v1/run', body);
  assert.deepEqual(await post(good, JSON.stringify({ command: 'rm x' })), [401, 'bad signature'], 'a signed request cannot be altered');
  const ts = String(Date.now() - 5 * 60 * 1000);
  assert.deepEqual(await post({ 'content-type': 'application/json', 'x-memobros-timestamp': ts, 'x-memobros-nonce': 'n1', 'x-memobros-signature': protocol.sign(w.secret, ts, 'n1', 'POST', '/v1/run', body) }, body), [401, 'stale request']);
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
  w = await start({ root, port: 0, allow: ['hostname'], name: 'test-worker' }); // a program that exists on Linux, macOS and Windows
  worker = { name: 'test-worker', url: w.url, secret: w.secret };
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
  }
  w.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
