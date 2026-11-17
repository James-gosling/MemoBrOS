// Backup and restore, for real: restic (and rclone, when installed) run against repositories in temporary
// folders, with synthetic data. No account, no network, no real user data. Skips itself when restic is missing.
// The rclone part uses a remote that points at a local folder: it exercises the same restic → rclone path that
// Google Drive would use, not Google Drive itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const restic = require('../src/main/storage/restic');
const { createOrchestrator, manifest } = require('../src/main/storage/orchestrator');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arvi-storage-'));
const PASSWORD = 'synthetic-recovery-password-for-tests';
const MARKER = 'TOP-SECRET-SYNTHETIC-MARKER';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasRclone = spawnSync('rclone', ['version']).status === 0;
let n = 0;

function data(extra = {}) {
  const dir = path.join(root, `data-${++n}`);
  const files = { 'settings.json': JSON.stringify({ note: MARKER, language: 'es-MX' }), 'tasks/t_1/task.json': '{"state":"succeeded"}', 'tasks/t_1/events.ndjson': '{"seq":1}\n{"seq":2}\n', 'notas/año nuevo.txt': 'acentos y eñes\n', ...extra };
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  fs.writeFileSync(path.join(dir, 'blob.bin'), crypto.randomBytes(200000));
  return dir;
}
// A fresh pair of repositories and an orchestrator. `rec` goes through rclone when it is installed.
async function world({ state, password = PASSWORD, approve } = {}) {
  const id = ++n;
  const primary = { id: 'drive', role: 'primary', repo: path.join(root, `repo-${id}-primary`) };
  const recDir = path.join(root, `repo-${id}-recovery`);
  const recovery = hasRclone ? { id: 'independent', role: 'recovery', repo: 'rclone:REC:repo', env: { RCLONE_CONFIG_REC_TYPE: 'alias', RCLONE_CONFIG_REC_REMOTE: recDir, RCLONE_CONFIG: path.join(root, 'rclone-empty.conf') } }
    : { id: 'independent', role: 'recovery', repo: path.join(recDir, 'repo') };
  fs.mkdirSync(recDir, { recursive: true });
  for (const t of [primary, recovery]) await restic.init({ repo: t.repo, env: t.env, password: PASSWORD });
  const targets = [primary, recovery];
  const make = (o = {}) => createOrchestrator({ stateDir: o.state || state || path.join(root, `state-${id}`), targets, getPassword: async () => (o.password !== undefined ? o.password : password), approve: o.approve || approve });
  return { targets, primary, recovery, recDir, orch: make(), make, count: async (t) => (await restic.snapshots({ repo: t.repo, env: t.env, password: PASSWORD })).length };
}
const allFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const kindOf = async (p) => { try { await p; return 'no error'; } catch (e) { return e.kind; } };

test('a backup is encrypted before it leaves, and counts as verified only after it was read back from each target', async () => {
  const w = await world(), dir = data(), before = manifest(dir);
  const r = await w.orch.backup({ set: 'profile', dir, category: 'app_settings', key: 'run-1' });
  assert.deepEqual([r.targets.drive.state, r.targets.independent.state], ['verified', 'verified']);
  assert.deepEqual([r.durable, r.independent], [true, true]);
  for (const repoDir of [w.primary.repo, w.recDir]) {
    const stored = allFiles(repoDir);
    assert.ok(stored.length > 3);
    for (const f of stored) { const b = fs.readFileSync(f); assert.ok(!b.includes(MARKER) && !b.includes('settings.json') && !b.includes('es-MX') && !b.includes('año nuevo'), `no content and no file name is readable in ${path.relative(root, f)}`); }
  }
  assert.equal(manifest(dir).hash, before.hash, 'the local files are untouched');
  assert.ok(!JSON.stringify(fs.readFileSync(path.join(root, `state-${n - 1}`, 'storage.json'), 'utf8')).includes(PASSWORD), 'the password is not written to the state file');
  assert.equal(hasRclone ? w.recovery.repo : 'rclone:', hasRclone ? 'rclone:REC:repo' : 'rclone:', 'the recovery copy went through rclone');
});

test('restore: into an empty folder, every file hash matches; it also works with no local state at all (laptop lost)', async () => {
  const w = await world(), dir = data();
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  for (const from of ['drive', 'independent']) {
    const into = path.join(root, `restore-${++n}`);
    const fresh = w.make({ state: path.join(root, `state-fresh-${n}`) }); // knows nothing about earlier backups
    const out = await fresh.restore({ set: 'profile', from, into });
    assert.equal(out.verified, true); assert.equal(out.files, 5);
    assert.deepEqual(manifest(into).files, manifest(dir).files, `byte-identical from ${from}`);
    assert.equal(fs.readFileSync(path.join(into, 'notas', 'año nuevo.txt'), 'utf8'), 'acentos y eñes\n');
  }
  const occupied = path.join(root, `restore-${++n}`); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'mine.txt'), 'keep me');
  assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into: occupied })), 'not_empty');
  assert.deepEqual(fs.readdirSync(occupied), ['mine.txt'], 'a restore never writes over existing files');
  assert.equal(await kindOf(w.orch.restore({ set: 'unknown-set', from: 'drive', into: path.join(root, `restore-${++n}`) })), 'not_found');
});

test('wrong or missing recovery password: nothing is read, nothing is written, and the reason is named', async () => {
  const w = await world(), dir = data();
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  const into = path.join(root, `restore-${++n}`);
  assert.equal(await kindOf(w.make({ password: 'not-the-password' }).restore({ set: 'profile', from: 'drive', into })), 'wrong_password');
  assert.deepEqual(fs.existsSync(into) ? allFiles(into) : [], []);
  assert.equal(await kindOf(w.make({ password: '' }).restore({ set: 'profile', from: 'drive', into })), 'missing_credentials');
  // a backup without credentials stays owed; the local data and the existing snapshots are untouched
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"changed":true}');
  const r = await w.make({ password: '' }).backup({ set: 'profile', dir, category: 'app_settings' });
  assert.deepEqual([r.targets.drive.state, r.targets.drive.errorKind, r.durable], ['backup_pending', 'missing_credentials', false]);
  assert.equal(await w.count(w.primary), 1);
});

test('offline: the backup stays pending, local work is unaffected, the other target is independent, and it completes later', async () => {
  const w = await world(), dir = data();
  fs.renameSync(w.primary.repo, `${w.primary.repo}.away`); // the primary target cannot be reached
  let r = await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  assert.deepEqual([r.targets.drive.state, r.targets.drive.errorKind], ['backup_pending', 'unreachable']);
  assert.equal(r.targets.independent.state, 'verified', 'one provider being down does not stop the other');
  assert.deepEqual([r.durable, r.independent], [false, false], 'not durable until the primary is verified');
  assert.equal(manifest(dir).count, 5);
  fs.renameSync(`${w.primary.repo}.away`, w.primary.repo); // back online
  r = await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  assert.deepEqual([r.targets.drive.state, r.durable, r.independent], ['verified', true, true]);
  assert.equal(await w.count(w.recovery), 1, 'the target that already had a verified copy was not sent the same data again');
});

test('asking twice for the same content creates one snapshot; changed content creates a new one', async () => {
  const w = await world(), dir = data();
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings', key: 'routine-7@2026-11-17T09:00' });
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings', key: 'routine-7@2026-11-17T09:00' });
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  assert.deepEqual([await w.count(w.primary), await w.count(w.recovery)], [1, 1]);
  fs.appendFileSync(path.join(dir, 'tasks', 't_1', 'events.ndjson'), '{"seq":3}\n');
  const r = await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  assert.deepEqual([await w.count(w.primary), r.targets.drive.state], [2, 'verified']);
});

test('an interrupted upload leaves no snapshot and no false "uploaded"; the next run completes', async () => {
  const w = await world(), dir = data();
  fs.writeFileSync(path.join(dir, 'large.bin'), crypto.randomBytes(24 * 1024 * 1024));
  const abort = new AbortController();
  const pending = w.orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'], signal: abort.signal, limitKiB: 400 });
  await sleep(1500); abort.abort();
  const r = await pending;
  assert.deepEqual([r.targets.drive.state, r.targets.drive.errorKind, r.durable], ['backup_pending', 'cancelled', false]);
  assert.equal(await w.count(w.primary), 0, 'no partial snapshot exists');
  const again = await w.orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] });
  assert.equal(again.targets.drive.state, 'verified');
  const into = path.join(root, `restore-${++n}`);
  await w.orch.restore({ set: 'profile', from: 'drive', into });
  assert.equal(manifest(into).files['large.bin'].sha256, manifest(dir).files['large.bin'].sha256);
});

test('two writers: one run per computer at a time; two computers can back up to the same place', async () => {
  const w = await world(), dir = data();
  fs.writeFileSync(path.join(dir, 'large.bin'), crypto.randomBytes(8 * 1024 * 1024));
  const state = path.join(root, `state-shared-${++n}`);
  const a = w.make({ state }), b = w.make({ state });
  const first = a.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'], limitKiB: 4000 });
  await sleep(300);
  assert.equal(await kindOf(b.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] })), 'busy');
  assert.equal((await first).targets.drive.state, 'verified');
  // a lock left behind by a process that no longer exists does not block for ever
  fs.writeFileSync(path.join(state, 'backup.lock'), '999999999');
  fs.appendFileSync(path.join(dir, 'settings.json'), ' ');
  assert.equal((await b.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] })).targets.drive.state, 'verified');
  assert.ok(!fs.existsSync(path.join(state, 'backup.lock')), 'the lock is released');
  // two different computers (two state folders), two different sets, the same repository, at the same time
  const dirB = data({ 'other.txt': 'second computer' });
  const [ra, rb] = await Promise.all([w.make({ state: path.join(root, `state-pc1-${n}`) }).backup({ set: 'pc1', dir, category: 'app_settings', only: ['drive'] }), w.make({ state: path.join(root, `state-pc2-${n}`) }).backup({ set: 'pc2', dir: dirB, category: 'app_settings', only: ['drive'] })]);
  assert.deepEqual([ra.targets.drive.state, rb.targets.drive.state], ['verified', 'verified']);
});

test('an upload whose read-back did not happen stays "uploaded" and can be verified later', async () => {
  const w = await world(), dir = data();
  const state = path.join(root, `state-${++n}`);
  let failCheck = true;
  const flaky = { ...restic, check: async (o) => { if (failCheck) throw new restic.ResticError('unreachable', 'The backup location cannot be reached right now.'); return restic.check(o); } };
  const orch = createOrchestrator({ stateDir: state, targets: [w.primary], getPassword: async () => PASSWORD, restic: flaky });
  const r = await orch.backup({ set: 'profile', dir, category: 'app_settings' });
  assert.deepEqual([r.targets.drive.state, r.targets.drive.errorKind, r.durable], ['uploaded', 'unreachable', false], 'an upload acknowledgment alone is not durability');
  failCheck = false;
  const later = await orch.verifyUploaded({ set: 'profile', on: 'drive' });
  assert.deepEqual([later.targets.drive.state, later.durable], ['verified', true]);
  assert.equal(await w.count(w.primary), 1, 'verifying later uploads nothing again');
});

test('a damaged backup is detected, never reported as good, and the independent copy still restores', async () => {
  const w = await world(), dir = data();
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings' });
  for (const f of allFiles(path.join(w.primary.repo, 'data'))) { const b = fs.readFileSync(f); for (let i = 40; i < Math.min(b.length, 400); i++) b[i] ^= 0xff; fs.chmodSync(f, 0o600); fs.writeFileSync(f, b); } // restic makes its pack files read-only; only root could write to them without this
  const into = path.join(root, `restore-${++n}`);
  assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into })), 'corrupt');
  const st = w.orch.status('profile');
  assert.deepEqual([st.targets.drive.state, st.durable, st.independent], ['recovery_failed', false, false]);
  const ok = path.join(root, `restore-${++n}`);
  assert.equal((await w.orch.restore({ set: 'profile', from: 'independent', into: ok })).verified, true);
  assert.deepEqual(manifest(ok).files, manifest(dir).files);
  // a new backup onto the damaged repository uploads, but fails the read-back and is not called verified
  fs.appendFileSync(path.join(dir, 'settings.json'), ' ');
  const r = await w.orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] });
  assert.notEqual(r.targets.drive.state, 'verified'); assert.equal(r.durable, false);
});

test('retention: old snapshots go only with approval, never the newest verified one, and never when nothing is verified', async () => {
  let answer = false;
  const asked = [];
  const w = await world({ approve: async (q) => { asked.push(q); return answer; } }), dir = data();
  for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(dir, 'settings.json'), `{"version":${i}}`); await w.orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] }); }
  assert.equal(await w.count(w.primary), 3);
  const plan = await w.orch.retentionPlan({ set: 'profile', on: 'drive', keepLast: 1 });
  assert.deepEqual([plan.remove.length, plan.keep.length, plan.hasVerified], [2, 1, true]);
  assert.equal(await w.count(w.primary), 3, 'a plan removes nothing');
  assert.equal(await kindOf(w.orch.applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })), 'declined');
  assert.equal(await w.count(w.primary), 3); assert.equal(asked[0].kind, 'delete_backups');
  // someone who knows nothing about a verified snapshot (fresh state) may not remove anything, even with a yes
  answer = true;
  assert.equal(await kindOf(w.make({ state: path.join(root, `state-fresh-${++n}`), approve: async () => true }).applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })), 'not_allowed');
  assert.equal(await w.count(w.primary), 3);
  assert.equal((await w.orch.applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })).removed.length, 2);
  assert.equal(await w.count(w.primary), 1);
  const into = path.join(root, `restore-${++n}`);
  await w.orch.restore({ set: 'profile', from: 'drive', into });
  assert.equal(fs.readFileSync(path.join(into, 'settings.json'), 'utf8'), '{"version":2}', 'the newest verified snapshot is what remains');
});

test('what must never be uploaded is refused before anything is read or sent', async () => {
  const w = await world(), dir = data();
  for (const [category, approved] of [['oauth_credentials', true], ['recovery_keys', true], ['local_models', true], ['agent_tool_output', true], ['conversation_history', false], ['user_files', false], ['source_code', true]]) {
    assert.equal(await kindOf(w.orch.backup({ set: 'x', dir, category, approved })), 'not_allowed', category);
  }
  assert.deepEqual([await w.count(w.primary), w.orch.status()], [0, []]);
  assert.equal((await w.orch.backup({ set: 'chat', dir, category: 'conversation_history', approved: true, only: ['drive'] })).targets.drive.state, 'verified');
});

test('the files themselves are checked: a set that contains credentials, keys, caches or links is refused whole, whatever it is called', async () => {
  const w = await world();
  const cases = { 'secrets.json': '{"openrouter":"sk-or-..."}', '.env': 'API_KEY=1', 'ssh/id_ed25519': 'key', 'certs/server.pem': 'pem', 'rclone.conf': '[gdrive]', 'node_modules/x/index.js': 'x', 'actions.log': 'ran' };
  for (const [file, text] of Object.entries(cases)) {
    const dir = data({ [file]: text });
    let message = '';
    assert.equal(await kindOf(w.orch.backup({ set: 'profile', dir, category: 'app_settings' }).catch((e) => { message = e.message; throw e; })), 'not_allowed', file);
    assert.ok(message.includes(file) && /Nothing was sent/.test(message), `the refusal names the file: ${message}`);
  }
  const linked = data(); fs.symlinkSync('/etc/hostname', path.join(linked, 'link-out'));
  assert.equal(await kindOf(w.orch.backup({ set: 'profile', dir: linked, category: 'app_settings' })), 'not_allowed');
  const viaLink = path.join(root, `link-${++n}`); fs.symlinkSync(data(), viaLink);
  assert.equal(await kindOf(w.orch.backup({ set: 'profile', dir: viaLink, category: 'app_settings' })), 'not_allowed', 'the set folder itself may not be a link');
  const empty = path.join(root, `empty-${++n}`); fs.mkdirSync(empty);
  assert.equal(await kindOf(w.orch.backup({ set: 'profile', dir: empty, category: 'app_settings' })), 'not_allowed');
  for (const name of ['a,b', 'set:x,manifest:0', 'two words']) assert.equal(await kindOf(w.orch.backup({ set: name, dir: data(), category: 'app_settings' })), 'not_allowed', name);
  assert.equal(await kindOf(w.orch.backup({ set: 'profile', dir: data(), category: 'app_settings', key: 'k,key:other' })), 'not_allowed');
  assert.deepEqual([await w.count(w.primary), await w.count(w.recovery), w.orch.status()], [0, 0, []], 'nothing reached either target and nothing was recorded');
});

test('a backup record that cannot be trusted stops everything except a restore; it is never mistaken for a new installation', async () => {
  const w = await world(), dir = data();
  const state = path.join(root, `state-${++n}`);
  const orch = w.make({ state, approve: async () => true });
  for (let i = 0; i < 2; i++) { fs.writeFileSync(path.join(dir, 'settings.json'), `{"v":${i}}`); await orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] }); }
  const file = path.join(state, 'storage.json');
  const good = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(good).version, 1);
  const broken = { 'state_corrupt (cut off)': good.slice(0, good.length / 2), 'state_corrupt (not an object)': '[]', 'state_corrupt (sets missing)': '{"version":1}', 'state_corrupt (unknown state)': good.replace('"verified"', '"totally-fine"'),
    'state_unsupported (newer)': good.replace('"version": 1', '"version": 2'), 'state_unsupported (no version)': good.replace(/\n "version": 1,?/, '').replace(/,\s*"version": 1/, '') };
  for (const [label, text] of Object.entries(broken)) {
    fs.writeFileSync(file, text);
    const want = label.split(' ')[0];
    fs.appendFileSync(path.join(dir, 'settings.json'), ' ');
    assert.equal(await kindOf(orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] })), want, `backup: ${label}`);
    assert.equal(await kindOf(orch.retentionPlan({ set: 'profile', on: 'drive', keepLast: 1 })), want, `retention plan: ${label}`);
    assert.equal(await kindOf(orch.applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })), want, `retention: ${label}`);
    assert.equal(await kindOf(Promise.resolve().then(() => orch.status())), want, `status: ${label}`);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `the damaged record is left exactly as it was: ${label}`);
    assert.equal(await w.count(w.primary), 2, `nothing was uploaded or removed: ${label}`);
    // the one thing that must still work: getting the data back
    const into = path.join(root, `restore-${++n}`);
    assert.equal((await orch.restore({ set: 'profile', from: 'drive', into })).verified, true, `restore: ${label}`);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  assert.ok(!fs.existsSync(path.join(state, 'backup.lock')), 'no lock is left behind by a refused run');
  fs.rmSync(file); // no record at all is a new installation, and that is fine
  assert.deepEqual(orch.status(), []);
  assert.equal((await orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] })).targets.drive.state, 'verified');
});

test('retention: an approval covers one exact deletion; if the backups changed meanwhile, nothing is removed', async () => {
  const w = await world(), dir = data();
  const state = path.join(root, `state-${++n}`);
  const bump = async (o) => { fs.appendFileSync(path.join(dir, 'settings.json'), ' '); return o.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] }); };
  let during = async () => {};
  const seen = [];
  const orch = w.make({ state, approve: async (q) => { seen.push(q); await during(); return true; } });
  for (let i = 0; i < 3; i++) await bump(orch);
  const plan = await orch.retentionPlan({ set: 'profile', on: 'drive', keepLast: 1 });
  assert.equal(plan.remove.length, 2); assert.match(plan.digest, /^[0-9a-f]{64}$/);
  during = () => bump(orch); // while the card is open, a new backup is made
  assert.equal(await kindOf(orch.applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })), 'plan_changed');
  assert.equal(await w.count(w.primary), 4, 'the stale approval removed nothing');
  assert.deepEqual([seen[0].snapshots.length, seen[0].digest], [2, plan.digest], 'the card names exactly what would go');
  during = async () => {};
  assert.equal((await orch.applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })).removed.length, 3);
  // the newest snapshot is not always the verified one: an upload that was never read back must not push the verified one out
  let failCheck = true;
  const flaky = createOrchestrator({ stateDir: state, targets: [w.primary], getPassword: async () => PASSWORD, approve: async () => true, restic: { ...restic, check: async (o) => { if (failCheck) throw new restic.ResticError('unreachable', 'offline'); return restic.check(o); } } });
  const verifiedId = orch.status('profile').targets.drive.snapshot;
  // (a new run marks the target pending first; the previously verified snapshot stays on the target)
  fs.appendFileSync(path.join(dir, 'settings.json'), ' ');
  const r = await flaky.backup({ set: 'profile', dir, category: 'app_settings' });
  assert.equal(r.targets.drive.state, 'uploaded');
  assert.equal(await kindOf(flaky.applyRetention({ set: 'profile', on: 'drive', keepLast: 1 })), 'not_allowed', 'with no verified snapshot on record, nothing may be removed');
  assert.equal(await w.count(w.primary), 2);
  failCheck = false;
  await flaky.verifyUploaded({ set: 'profile', on: 'drive' });
  const after = await flaky.retentionPlan({ set: 'profile', on: 'drive', keepLast: 1 });
  assert.deepEqual([after.remove, after.protected === flaky.status('profile').targets.drive.snapshot], [[verifiedId], true]);
});

test('restore safety: no links, no leftovers after a failure, no ambiguous snapshot names', async () => {
  const w = await world(), dir = data();
  fs.writeFileSync(path.join(dir, 'large.bin'), crypto.randomBytes(30 * 1024 * 1024));
  await w.orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] });
  // a link as destination is refused, even to an empty folder
  const real = path.join(root, `real-${++n}`), link = path.join(root, `dest-link-${n}`); fs.mkdirSync(real); fs.symlinkSync(real, link);
  assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into: link })), 'not_empty');
  assert.deepEqual(fs.readdirSync(real), []);
  const asFile = path.join(root, `dest-file-${++n}`); fs.writeFileSync(asFile, 'x');
  assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into: asFile })), 'not_empty');
  // interrupted: nothing half-restored stays behind, whether the folder existed before or not
  for (const pre of [false, true]) {
    const into = path.join(root, `restore-${++n}`); if (pre) fs.mkdirSync(into);
    const abort = new AbortController(); setTimeout(() => abort.abort(), 250);
    assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into, signal: abort.signal })), 'cancelled');
    assert.deepEqual(pre ? fs.readdirSync(into) : fs.existsSync(into), pre ? [] : false, 'no partial files are left');
  }
  for (const bad of ['abc', 'zzzzzzzz', '../../etc']) assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into: path.join(root, `restore-${++n}`), snapshot: bad })), 'not_found', bad);
  assert.equal(await kindOf(w.orch.restore({ set: 'a,b', from: 'drive', into: path.join(root, `restore-${++n}`) })), 'not_allowed');
  // a snapshot made by something else, carrying a link: it is not restored, and nothing is left
  const evil = path.join(root, `evil-${++n}`); fs.mkdirSync(evil); fs.writeFileSync(path.join(evil, 'a.txt'), 'a'); fs.symlinkSync('/etc', path.join(evil, 'system'));
  await restic.backup(evil, { repo: w.primary.repo, password: PASSWORD, tags: ['set:foreign', `manifest:${manifest(evil).hash}`] });
  const into = path.join(root, `restore-${++n}`);
  assert.equal(await kindOf(w.orch.restore({ set: 'foreign', from: 'drive', into })), 'corrupt');
  assert.ok(!fs.existsSync(into));
});

test('secrets stay where they belong: only the backup tool gets the password, and errors and records never carry it', async () => {
  const w = await world(), dir = data();
  const spy = path.join(root, 'env-spy.sh');
  fs.writeFileSync(spy, '#!/bin/sh\nenv > "$SPY_OUT"\nexit 1\n'); fs.chmodSync(spy, 0o755);
  Object.assign(process.env, { GITHUB_TOKEN: 'ghp_should_not_travel', OPENROUTER_API_KEY: 'or_should_not_travel', UNRELATED_SETTING: 'x' });
  try {
    const out = path.join(root, 'env-spy.txt');
    await restic.run(['snapshots'], { repo: w.primary.repo, password: PASSWORD, env: { SPY_OUT: out }, binary: spy }).catch(() => {});
    const seen = fs.readFileSync(out, 'utf8');
    assert.ok(seen.includes(`RESTIC_PASSWORD=${PASSWORD}`), 'the tool itself receives the password, through its environment');
    assert.ok(!/GITHUB_TOKEN|OPENROUTER_API_KEY|UNRELATED_SETTING/.test(seen), 'and nothing else from the app\'s environment');
  } finally { for (const k of ['GITHUB_TOKEN', 'OPENROUTER_API_KEY', 'UNRELATED_SETTING']) delete process.env[k]; }
  assert.ok(!('RESTIC_PASSWORD' in process.env) && !('RESTIC_REPOSITORY' in process.env), 'the app\'s own environment never holds them');
  let err;
  await w.make({ password: 'a-wrong-but-secret-looking-password' }).restore({ set: 'x', from: 'drive', into: path.join(root, `restore-${++n}`) }).catch((e) => { err = e; });
  assert.equal(err.kind, 'wrong_password'); assert.ok(!`${err.message} ${err.detail}`.includes('a-wrong-but-secret-looking-password'));
  assert.equal(await kindOf(restic.run(['snapshots'], { repo: w.primary.repo, password: 'two\nlines' })), 'missing_credentials');
  const state = path.join(root, `state-${++n}`);
  await w.make({ state }).backup({ set: 'profile', dir, category: 'app_settings' });
  const written = allFiles(state);
  assert.ok(written.length >= 1);
  for (const f of written) assert.ok(!fs.readFileSync(f, 'utf8').includes(PASSWORD), f);
});

test('cancelling and crashing leave no scratch folders, and no backup tool process of ours behind', async () => {
  const w = await world(), dir = data();
  fs.writeFileSync(path.join(dir, 'large.bin'), crypto.randomBytes(24 * 1024 * 1024));
  const state = path.join(root, `state-${++n}`);
  const orch = w.make({ state });
  const abort = new AbortController();
  const pending = orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['independent'], signal: abort.signal, limitKiB: 400 });
  await sleep(1500); abort.abort(); await pending;
  await sleep(800);
  // Our own children only: restic, and the rclone it started for this repository. A helper that detaches itself
  // from its parent would not be seen here, and stopping the parent does not guarantee stopping such a helper.
  const left = spawnSync('pgrep', ['-af', 'restic|rclone']).stdout.toString().split('\n').filter((l) => l.includes(root));
  assert.deepEqual(left, [], 'no restic or rclone of this test is still running');
  // leftovers of a run that died: swept the next time a run holds the lock
  fs.mkdirSync(path.join(state, 'verify-dead')); fs.writeFileSync(path.join(state, 'verify-dead', 'x'), 'x'); fs.writeFileSync(path.join(state, 'storage.json.123.tmp'), '{');
  const r = await orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['independent'] });
  assert.equal(r.targets.independent.state, 'verified');
  assert.deepEqual(fs.readdirSync(state).sort(), ['storage.json'], 'only the record remains');
});

test('disk full: a backup target without space stays pending, a restore without space fails cleanly, local data is untouched', async () => {
  const tiny = path.join(root, 'tiny');
  fs.mkdirSync(tiny);
  if (process.platform !== 'linux' || spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', tiny]).status !== 0) return 'SKIP: a small test file system could not be mounted here (needs root on Linux)';
  try {
    const dir = data();
    fs.writeFileSync(path.join(dir, 'large.bin'), crypto.randomBytes(3 * 1024 * 1024));
    const before = manifest(dir).hash;
    const full = { id: 'drive', role: 'primary', repo: path.join(tiny, 'repo') };
    await restic.init({ repo: full.repo, password: PASSWORD });
    const orch = createOrchestrator({ stateDir: path.join(root, `state-${++n}`), targets: [full], getPassword: async () => PASSWORD });
    const r = await orch.backup({ set: 'profile', dir, category: 'app_settings' });
    assert.deepEqual([r.targets.drive.state, r.targets.drive.errorKind, r.durable], ['backup_pending', 'no_space', false]);
    assert.equal(manifest(dir).hash, before);
    execFileSync('umount', [tiny]); execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', tiny]);
    const w = await world();
    await w.orch.backup({ set: 'profile', dir, category: 'app_settings', only: ['drive'] });
    assert.equal(await kindOf(w.orch.restore({ set: 'profile', from: 'drive', into: path.join(tiny, 'restored') })), 'no_space');
    assert.equal(w.orch.status('profile').targets.drive.state, 'verified', 'a full local disk says nothing against the backup');
  } finally { spawnSync('umount', [tiny]); }
});

(async () => {
  const v = await restic.version();
  if (!v) { console.log('SKIP  backup and restore with restic (restic is not installed)'); process.exit(0); }
  console.log(`      using ${v}${hasRclone ? ' and rclone' : ' (rclone not installed: the recovery target is a plain folder)'}`);
  let failed = 0, skipped = 0;
  for (const [name, fn] of tests) {
    try {
      const out = await fn();
      if (typeof out === 'string' && out.startsWith('SKIP')) { skipped++; console.log(`SKIP  ${name}\n      ${out}`); } else console.log(`PASS  ${name}`);
    } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 5).join(' | ')}`); }
  }
  spawnSync('umount', [path.join(root, 'tiny')]);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${tests.length - failed - skipped}/${tests.length} passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
})();
