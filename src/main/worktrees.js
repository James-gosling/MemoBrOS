// Git worktree isolation for coding agents.
// Every write-enabled agent gets its own branch and its own working directory, so agents never share files while
// they work. Their branches are validated one by one, test-merged in a scratch integration worktree to find
// conflicts, and only reach the user's branch through a fast-forward the user approves.
//
// Rules this module keeps:
//  - no destructive Git: no reset --hard, no clean, no checkout over changes, no forced worktree removal, no
//    branch deletion. The only abort is `git merge --abort` inside the scratch integration worktree.
//  - the user's working tree is touched once, by `git merge --ff-only`, which Git itself refuses whenever it
//    would overwrite uncommitted changes.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } }, (err, stdout, stderr) => {
      const out = { ok: !err, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
      if (err && !allowFail) reject(new Error(`git ${args.join(' ')} failed: ${out.stderr || err.message}`));
      else resolve(out);
    });
  });
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'agent';

// Is `project` a Git repository where worktrees can be used? Returns { ok, root, head, branch } or { ok: false, reason }.
async function inspect(project) {
  if (!project || !fs.existsSync(project)) return { ok: false, reason: 'the project folder does not exist' };
  const top = await git(project, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top.ok) return { ok: false, reason: 'the project folder is not a Git repository' };
  const head = await git(project, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (!head.ok) return { ok: false, reason: 'the repository has no commits yet' };
  const branch = await git(project, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  if (!branch.ok) return { ok: false, reason: 'the repository is on a detached HEAD' };
  const wt = await git(project, ['worktree', 'list'], { allowFail: true });
  if (!wt.ok) return { ok: false, reason: 'this Git version does not support worktrees' };
  return { ok: true, root: fs.realpathSync(top.stdout), head: head.stdout, branch: branch.stdout };
}

// Creates branch memobros/<run>/<name> at `base` in its own directory under `home`.
async function create(repo, home, run, name, base) {
  const dir = path.join(home, run, slug(name));
  const branch = `memobros/${run}/${slug(name)}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, dir, base]);
  return { dir: fs.realpathSync(dir), branch, base };
}

// ---- one writer per directory ---------------------------------------------------------------
const writers = new Map(); // real path → agent name
function acquire(dir, who) {
  const key = fs.realpathSync(dir);
  if (writers.has(key)) throw new Error(`${writers.get(key)} is already writing in ${key}; ${who} cannot use the same working directory.`);
  writers.set(key, who);
  return () => { if (writers.get(key) === who) writers.delete(key); };
}
const writerOf = (dir) => { try { return writers.get(fs.realpathSync(dir)) || null; } catch { return null; } };

// ---- committing, validating, comparing ----------------------------------------------------------
// Commits everything the agent left in its worktree to its own branch. Returns the files changed since `base`.
async function commitAll(wt, message) {
  await git(wt.dir, ['add', '-A']);
  const staged = await git(wt.dir, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (!staged.ok) {
    const who = (await git(wt.dir, ['config', 'user.name'], { allowFail: true })).stdout ? [] : ['-c', 'user.name=MemoBrOS crew', '-c', 'user.email=memobros@localhost'];
    await git(wt.dir, [...who, 'commit', '--no-verify', '-m', message]);
  }
  return changedFiles(wt.dir, wt.base);
}
async function changedFiles(dir, base, tip = 'HEAD') {
  const out = await git(dir, ['diff', '--name-only', `${base}..${tip}`]);
  return out.stdout ? out.stdout.split('\n') : [];
}

// "*.pem", ".env*", ".github/workflows/**" style patterns; a pattern without a slash matches the file name anywhere.
function matches(file, pattern) {
  const re = new RegExp(`^${pattern.split('**').map((p) => p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  return re.test(file) || (!pattern.includes('/') && re.test(path.basename(file)));
}
const protectedHits = (files, patterns) => files.filter((f) => patterns.some((p) => matches(f, p)));

// Checks one worktree on its own: no leftover conflict markers / whitespace errors, then the user's check command.
async function validate(wt, command, splitCommand) {
  const check = await git(wt.dir, ['diff', '--check', `${wt.base}..HEAD`], { allowFail: true });
  if (!check.ok) return { ok: false, detail: `git diff --check: ${check.stdout.split('\n').slice(0, 3).join('; ')}` };
  if (!command) return { ok: true, detail: 'no check command set' };
  const [cmd, ...args] = splitCommand(command);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { cwd: wt.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on('data', (d) => { out = (out + d).slice(-2000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, detail: `could not run "${command}": ${e.message}` }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, detail: code === 0 ? `"${command}" passed` : `"${command}" failed (exit ${code}): ${out.trim().split('\n').slice(-3).join(' | ')}` }); });
  });
}

// Test-merges `branch` into the scratch integration worktree. A conflict is undone there and reported.
async function tryMerge(integration, branch) {
  const who = (await git(integration.dir, ['config', 'user.name'], { allowFail: true })).stdout ? [] : ['-c', 'user.name=MemoBrOS crew', '-c', 'user.email=memobros@localhost'];
  const merge = await git(integration.dir, [...who, 'merge', '--no-ff', '--no-edit', branch], { allowFail: true });
  if (merge.ok) return { ok: true, conflicts: [] };
  const unmerged = await git(integration.dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  await git(integration.dir, ['merge', '--abort'], { allowFail: true });
  return { ok: false, conflicts: unmerged.stdout ? unmerged.stdout.split('\n') : [], detail: merge.stdout.split('\n').filter((l) => /CONFLICT/.test(l)).join('; ') || merge.stderr };
}

// Brings the integrated work into the user's branch, only as a fast-forward and only if nothing moved meanwhile.
async function fastForward(repo, expected, branch) {
  const now = await inspect(repo);
  if (!now.ok) return { ok: false, reason: now.reason };
  if (now.branch !== expected.branch) return { ok: false, reason: `you switched from ${expected.branch} to ${now.branch}` };
  if (now.head !== expected.head) return { ok: false, reason: `${expected.branch} gained new commits while the crew worked` };
  const merge = await git(repo, ['merge', '--ff-only', branch], { allowFail: true });
  return merge.ok ? { ok: true } : { ok: false, reason: (merge.stderr || merge.stdout).split('\n').filter(Boolean).slice(0, 2).join(' ') };
}

// Removes a worktree directory only when Git agrees it holds nothing uncommitted. The branch is always kept.
async function removeIfClean(repo, wt) {
  const status = await git(wt.dir, ['status', '--porcelain'], { allowFail: true });
  if (!status.ok || status.stdout) return false;
  return (await git(repo, ['worktree', 'remove', wt.dir], { allowFail: true })).ok;
}

const statusOf = async (dir) => (await git(dir, ['status', '--porcelain'], { allowFail: true })).stdout;

module.exports = { git, inspect, create, acquire, writerOf, commitAll, changedFiles, protectedHits, matches, validate, tryMerge, fastForward, removeIfClean, statusOf, slug };
