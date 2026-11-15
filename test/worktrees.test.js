// Unit tests for the Git worktree isolation layer (plain Node, real Git, temporary repositories).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const wt = require('../src/main/worktrees');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.name', 'Tester'); sh(repo, 'config', 'user.email', 't@example.com');
  write(repo, 'shared.txt', 'original\n'); write(repo, 'keep.txt', 'keep\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'first commit');
  write(repo, 'second.txt', 'two\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'second commit');
  return repo;
}
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-home-'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a folder without Git, or without commits, is reported as unusable for worktrees', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plain-'));
  assert.deepEqual(await wt.inspect(plain), { ok: false, reason: 'the project folder is not a Git repository' });
  sh(plain, 'init', '-q');
  assert.equal((await wt.inspect(plain)).reason, 'the repository has no commits yet');
  assert.equal((await wt.inspect('/nope/nothing')).ok, false);
});

test('each agent gets its own directory and branch; files do not leak between them or into the project', async () => {
  const repo = makeRepo(), h = home(), info = await wt.inspect(repo);
  const a = await wt.create(repo, h, 'run1', 'Agent A', info.head), b = await wt.create(repo, h, 'run1', 'Agent B', info.head);
  assert.notEqual(a.dir, b.dir); assert.notEqual(a.branch, b.branch);
  assert.ok(!a.dir.startsWith(info.root) && !b.dir.startsWith(info.root), 'worktrees live outside the project folder');
  write(a.dir, 'a.txt', 'from A\n');
  assert.ok(!fs.existsSync(path.join(b.dir, 'a.txt')) && !fs.existsSync(path.join(repo, 'a.txt')));
  assert.deepEqual(await wt.commitAll(a, 'A work'), ['a.txt']);
  assert.equal(sh(repo, 'status', '--porcelain'), '', 'the project working tree is untouched');
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), info.head, 'the project branch did not move');
});

test('two writers cannot hold the same working directory', async () => {
  const repo = makeRepo(), tree = await wt.create(repo, home(), 'run1', 'solo', (await wt.inspect(repo)).head);
  const release = wt.acquire(tree.dir, 'Agent A');
  assert.throws(() => wt.acquire(tree.dir, 'Agent B'), /Agent A is already writing in .*Agent B cannot use the same working directory/);
  assert.throws(() => wt.acquire(path.join(tree.dir, '.'), 'Agent B'), /already writing/, 'the same directory by another spelling is still locked');
  assert.equal(wt.writerOf(tree.dir), 'Agent A');
  release();
  wt.acquire(tree.dir, 'Agent B')(); // free again once released
  const other = wt.acquire(repo, 'Agent C'); // a different directory is independent
  assert.throws(() => wt.acquire(repo, 'Agent D'), /already writing/);
  other();
});

test('conflicting branches are detected before integration, and the integration tree is left clean', async () => {
  const repo = makeRepo(), h = home(), info = await wt.inspect(repo);
  const integration = await wt.create(repo, h, 'run1', 'integration', info.head);
  const a = await wt.create(repo, h, 'run1', 'a', info.head), b = await wt.create(repo, h, 'run1', 'b', info.head), c = await wt.create(repo, h, 'run1', 'c', info.head);
  write(a.dir, 'shared.txt', 'version A\n'); await wt.commitAll(a, 'A');
  write(b.dir, 'shared.txt', 'version B\n'); write(b.dir, 'b-only.txt', 'b\n'); await wt.commitAll(b, 'B');
  write(c.dir, 'c-only.txt', 'c\n'); await wt.commitAll(c, 'C');
  assert.deepEqual(await wt.tryMerge(integration, a.branch), { ok: true, conflicts: [] });
  const clash = await wt.tryMerge(integration, b.branch);
  assert.equal(clash.ok, false); assert.deepEqual(clash.conflicts, ['shared.txt']);
  assert.equal(sh(integration.dir, 'status', '--porcelain'), '', 'no half-merged state is left behind');
  assert.equal(read(integration.dir, 'shared.txt'), 'version A\n', "the first agent's work is intact");
  assert.ok(!fs.existsSync(path.join(integration.dir, 'b-only.txt')), 'nothing from the conflicting branch slipped in');
  assert.equal((await wt.tryMerge(integration, c.branch)).ok, true, 'later non-conflicting work still integrates');
  assert.equal(read(b.dir, 'shared.txt'), 'version B\n', 'the conflicting agent keeps its own work on its branch');
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), info.head, 'the project branch is untouched by all of this');
});

test('merging into the project is a fast-forward that never overwrites uncommitted work', async () => {
  const repo = makeRepo(), h = home(), info = await wt.inspect(repo);
  const integration = await wt.create(repo, h, 'run1', 'integration', info.head), a = await wt.create(repo, h, 'run1', 'a', info.head);
  write(a.dir, 'shared.txt', 'version A\n'); write(a.dir, 'new.txt', 'new\n'); await wt.commitAll(a, 'A');
  await wt.tryMerge(integration, a.branch);
  // the user has uncommitted edits to a file the crew also changed: Git must refuse and leave their edit alone
  write(repo, 'shared.txt', 'my unsaved edit\n'); write(repo, 'notes.txt', 'untracked notes\n');
  const refused = await wt.fastForward(repo, info, integration.branch);
  assert.equal(refused.ok, false); assert.match(refused.reason, /overwritten|local changes/i);
  assert.equal(read(repo, 'shared.txt'), 'my unsaved edit\n'); assert.equal(read(repo, 'notes.txt'), 'untracked notes\n');
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), info.head);
  // with only unrelated uncommitted files, it goes through and those files survive
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'original\n'); write(repo, 'keep.txt', 'my edit to keep\n');
  assert.deepEqual(await wt.fastForward(repo, info, integration.branch), { ok: true });
  assert.equal(read(repo, 'shared.txt'), 'version A\n'); assert.equal(read(repo, 'new.txt'), 'new\n');
  assert.equal(read(repo, 'keep.txt'), 'my edit to keep\n'); assert.equal(read(repo, 'notes.txt'), 'untracked notes\n');
});

test('a branch that moved, or a different checked-out branch, blocks the merge', async () => {
  const repo = makeRepo(), h = home(), info = await wt.inspect(repo);
  const integration = await wt.create(repo, h, 'run1', 'integration', info.head), a = await wt.create(repo, h, 'run1', 'a', info.head);
  write(a.dir, 'new.txt', 'new\n'); await wt.commitAll(a, 'A'); await wt.tryMerge(integration, a.branch);
  write(repo, 'mine.txt', 'mine\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'my own commit');
  assert.match((await wt.fastForward(repo, info, integration.branch)).reason, /gained new commits/);
  sh(repo, 'checkout', '-q', '-b', 'elsewhere');
  assert.match((await wt.fastForward(repo, info, integration.branch)).reason, /switched from main to elsewhere/);
  assert.ok(!fs.existsSync(path.join(repo, 'new.txt')));
});

test('cleanup is non-destructive: dirty worktrees stay, branches stay, history stays', async () => {
  const repo = makeRepo(), h = home(), info = await wt.inspect(repo);
  const history = sh(repo, 'log', '--format=%H %s');
  const clean = await wt.create(repo, h, 'run1', 'clean', info.head), dirty = await wt.create(repo, h, 'run1', 'dirty', info.head);
  write(clean.dir, 'c.txt', 'c\n'); await wt.commitAll(clean, 'clean work');
  write(dirty.dir, 'unsaved.txt', 'not committed\n');
  assert.equal(await wt.removeIfClean(repo, clean), true); assert.ok(!fs.existsSync(clean.dir));
  assert.equal(await wt.removeIfClean(repo, dirty), false, 'a worktree with uncommitted files is never removed');
  assert.equal(read(dirty.dir, 'unsaved.txt'), 'not committed\n');
  const branches = sh(repo, 'branch', '--format=%(refname:short)').split('\n');
  assert.ok(branches.includes(clean.branch) && branches.includes(dirty.branch), 'branches are kept even after their worktree is removed');
  assert.equal(sh(repo, 'show', `${clean.branch}:c.txt`), 'c');
  assert.equal(sh(repo, 'log', '--format=%H %s'), history, 'project history is identical');
  execFileSync('git', ['fsck', '--no-progress'], { cwd: repo });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'worktrees.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['reset', '--hard', 'clean', '--force', "'-f'", "'-D'", 'checkout', 'stash', 'rebase', 'push']) assert.ok(!source.includes(banned), `worktrees.js must not use "${banned}"`);
});

test('protected-file patterns and independent validation', async () => {
  const pats = ['.env*', '*.pem', 'package-lock.json', '.github/workflows/**'];
  assert.deepEqual(wt.protectedHits(['src/a.js', '.env.local', 'deploy/key.pem', 'web/package-lock.json', '.github/workflows/ci.yml', 'docs/env.md'], pats), ['.env.local', 'deploy/key.pem', 'web/package-lock.json', '.github/workflows/ci.yml']);
  const repo = makeRepo(), h = home(), info = await wt.inspect(repo);
  const good = await wt.create(repo, h, 'run1', 'good', info.head), bad = await wt.create(repo, h, 'run1', 'bad', info.head);
  write(good.dir, 'ok.txt', 'fine\n'); await wt.commitAll(good, 'good');
  write(bad.dir, 'ok.txt', '<<<<<<< HEAD\nleftover marker\n'); await wt.commitAll(bad, 'bad');
  const split = (c) => c.split(' ');
  assert.equal((await wt.validate(good, '', split)).ok, true);
  assert.equal((await wt.validate(bad, '', split)).ok, false, 'leftover conflict markers fail validation');
  assert.equal((await wt.validate(good, 'test -f ok.txt', split)).ok, true, 'the check command runs inside that agent\'s worktree');
  assert.match((await wt.validate(good, 'test -f missing.txt', split)).detail, /failed \(exit 1\)/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 4).join(' | ')}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
