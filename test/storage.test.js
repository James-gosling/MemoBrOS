// Tests for the storage placement policy. Plain Node, no tools, no network: runs on Linux and Windows.
const assert = require('assert');
const policy = require('../src/main/storage/policy');
const { classify } = require('../src/main/storage/restic');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('every category has one authority and a complete rule', () => {
  for (const [name, c] of Object.entries(policy.CATEGORIES)) {
    assert.ok(['source', 'local', 'archive', 'cache'].includes(c.authority), name);
    assert.ok(['git', 'backup', 'ask', 'never'].includes(c.upload), name);
    assert.ok(['never', 'reconstructable', 'by_age', 'after_verified_backup'].includes(c.evict), name);
    assert.equal(typeof c.encrypt, 'boolean', name);
    if (['backup', 'ask'].includes(c.upload)) assert.equal(c.encrypt, true, `${name}: anything that leaves this computer through a backup is encrypted first`);
    if (c.authority === 'cache') assert.deepEqual([c.upload, c.evict], ['never', 'reconstructable'], `${name}: caches are never uploaded and can always be rebuilt`);
  }
  assert.throws(() => policy.placement('nonsense'), /Unknown data category/);
});

test('secrets, credentials, raw output and caches are never uploaded; private history only after approval', () => {
  for (const c of ['oauth_credentials', 'recovery_keys', 'screenshots_audio', 'agent_tool_output', 'logs', 'local_models', 'dependencies', 'build_outputs', 'package_caches', 'temporary_files']) {
    assert.equal(policy.mayUpload(c).ok, false, c); assert.equal(policy.mayUpload(c, { approved: true }).ok, false, `${c}: approval does not change "never"`);
  }
  for (const c of ['source_code', 'git_history', 'architecture_docs']) assert.match(policy.mayUpload(c, { approved: true }).reason, /versioned with Git/);
  for (const c of ['conversation_history', 'user_files', 'generated_artifacts']) { assert.equal(policy.mayUpload(c).ok, false, c); assert.equal(policy.mayUpload(c, { approved: true }).ok, true, c); }
  for (const c of ['app_settings', 'task_records', 'approval_history', 'redacted_traces', 'memory_notes', 'routines']) assert.equal(policy.mayUpload(c).ok, true, c);
});

test('a backup only counts as durable once it was read back; states cannot skip ahead', () => {
  assert.equal(policy.canMove('local_committed', 'backup_pending'), true);
  for (const [from, to] of [['local_committed', 'uploaded'], ['local_committed', 'verified'], ['backup_pending', 'verified'], ['restore_required', 'verified'], ['recovery_failed', 'verified']]) assert.equal(policy.canMove(from, to), false, `${from} → ${to}`);
  assert.equal(policy.canMove('uploaded', 'verified'), true); assert.equal(policy.canMove('uploaded', 'recovery_failed'), true);
  const t = (role, state) => ({ role, state });
  assert.deepEqual(policy.durability([t('primary', 'uploaded')]), { durable: false, independent: false }, 'an upload acknowledgment is not durability');
  assert.deepEqual(policy.durability([t('primary', 'verified'), t('recovery', 'uploaded')]), { durable: true, independent: false });
  assert.deepEqual(policy.durability([t('primary', 'verified'), t('recovery', 'verified')]), { durable: true, independent: true });
  assert.deepEqual(policy.durability([t('primary', 'recovery_failed'), t('recovery', 'verified')]), { durable: false, independent: false });
});

test('freeing space: only what can be rebuilt, or what has a verified backup AND the user\'s approval; never the user\'s own files', () => {
  const items = [
    { path: 'node_modules', category: 'dependencies', bytes: 500 }, { path: 'models/base', category: 'local_models', bytes: 300 },
    { path: 'tasks/old', category: 'task_records', bytes: 40, verifiedRemote: false }, { path: 'tasks/older', category: 'task_records', bytes: 60, verifiedRemote: true },
    { path: 'Documents/thesis.odt', category: 'user_files', bytes: 900, verifiedRemote: true, ageDays: 4000 }, { path: 'settings.json', category: 'app_settings', bytes: 1, verifiedRemote: true },
    { path: 'actions.log.1', category: 'logs', bytes: 10, ageDays: 90 }, { path: 'actions.log', category: 'logs', bytes: 10, ageDays: 2 },
  ];
  const plain = policy.evictionPlan(items);
  assert.deepEqual(plain.free.map((x) => x.path), ['node_modules', 'models/base', 'actions.log.1']); assert.equal(plain.bytes, 810);
  assert.match(plain.keep.find((x) => x.path === 'tasks/old').reason, /no verified backup/);
  assert.match(plain.keep.find((x) => x.path === 'tasks/older').reason, /needs your approval/);
  const approved = policy.evictionPlan(items, { approved: ['task_records', 'user_files', 'app_settings'] });
  assert.deepEqual(approved.free.map((x) => x.path), ['node_modules', 'models/base', 'tasks/older', 'actions.log.1'], 'unverified data stays even when approved');
  assert.ok(approved.keep.some((x) => x.path === 'Documents/thesis.odt') && approved.keep.some((x) => x.path === 'settings.json'), 'old does not mean removable');
  assert.equal(typeof policy.evictionPlan, 'function'); assert.ok(!/unlink|rmSync|rmdir/.test(require('fs').readFileSync(require.resolve('../src/main/storage/policy'), 'utf8')), 'the policy module cannot delete anything');
});

test('the disk budget reports what is over its ceiling', () => {
  const r = policy.budgetReport({ dependencies: 600, local_models: 100, logs: 5 }, { dependencies: 550, local_models: 400 });
  assert.deepEqual(r.filter((x) => x.over).map((x) => x.category), ['dependencies']); assert.equal(r.find((x) => x.category === 'logs').limit, null);
});

test('errors of the backup tool are named by what the user can do about them', () => {
  const kinds = { 'Fatal: wrong password or no key found': 'wrong_password', 'Fatal: unable to open config file: stat /x/config: no such file or directory\nIs there a repository at the following location?': 'unreachable',
    'Fatal: unable to save snapshot: write /r/x: no space left on device': 'no_space', 'unable to create lock in backend: repository is already locked by PID 4': 'locked',
    'Pack ID does not match, want a, got b\nFatal: repository contains errors': 'corrupt', 'something else': 'failed' };
  for (const [text, kind] of Object.entries(kinds)) assert.equal(classify(text)[0], kind, text);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); } }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
