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
  for (const f of allFiles(path.join(w.primary.repo, 'data'))) { const b = fs.readFileSync(f); for (let i = 40; i < Math.min(b.length, 400); i++) b[i] ^= 0xff; fs.writeFileSync(f, b); }
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

test('disk full: a backup target without space stays pending, a restore without space fails cleanly, local data is untouched', async () => {
  const tiny = path.join(root, 'tiny');
  fs.mkdirSync(tiny);
  if (process.platform !== 'linux' || spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', tiny]).status !== 0) { console.log('      (skipped: a small test file system could not be mounted here; needs root on Linux)'); return; }
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
  let failed = 0;
  for (const [name, fn] of tests) { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 5).join(' | ')}`); } }
  spawnSync('umount', [path.join(root, 'tiny')]);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
