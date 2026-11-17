// A thin, typed wrapper around the restic command-line tool. restic does the cryptography, the deduplication and
// the repository format; nothing of that is reimplemented here. No Electron.
//
// The repository password never appears on a command line or in a file written by this module: it is handed to
// restic through the environment of that one child process.
const { spawn, execFile } = require('child_process');

// Error text from the tools can quote the repository address; an address can carry a user name and a password.
const scrub = (text, secrets = []) => {
  let out = String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  for (const s of secrets) if (s && String(s).length >= 4) out = out.split(String(s)).join('[redacted]');
  return out;
};

class ResticError extends Error {
  // kind: missing_tool | missing_credentials | wrong_password | unreachable | corrupt | no_space | cancelled | locked | failed
  constructor(kind, message, detail = '') { super(message); this.kind = kind; this.detail = detail; }
}

function classify(stderr) {
  const t = String(stderr);
  if (/wrong password or no key found/i.test(t)) return ['wrong_password', 'The recovery password does not open this backup.'];
  if (/Is there a repository at the following location|unable to open config file|no such host|connection refused|network is unreachable|dial tcp|couldn't (find|connect)|didn't find section in config file|error talking HTTP to rclone/i.test(t)) return ['unreachable', 'The backup location cannot be reached right now.'];
  if (/no space left on device|disk quota exceeded|storageQuotaExceeded|insufficient storage/i.test(t)) return ['no_space', 'There is not enough space to finish.'];
  if (/unable to create lock|repository is already locked/i.test(t)) return ['locked', 'Another backup is using this location.'];
  if (/ciphertext verification failed|pack .* (contains|does not match)|invalid data returned|Data seems to be missing|errors were found|damaged|hash does not match|incomplete pack/i.test(t)) return ['corrupt', 'The backup is damaged: what was read does not match what was written.'];
  return ['failed', 'The backup tool reported an error.'];
}

// Runs restic once. → { stdout, stderr }; throws ResticError.
function run(args, { repo, password, env = {}, cwd, signal, binary = 'restic' } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof password === 'string' && /[\r\n\0]/.test(password)) return reject(new ResticError('missing_credentials', 'The recovery password contains a line break, which the backup tool cannot take.'));
    if (repo && !password) return reject(new ResticError('missing_credentials', 'No recovery password is available, so nothing was sent or read.'));
    if (signal?.aborted) return reject(new ResticError('cancelled', 'Stopped.'));
    const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, ...env, ...(repo ? { RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: password } : {}) };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(binary, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const end = (fn) => { if (!done) { done = true; signal?.removeEventListener('abort', stop); fn(); } };
    const stop = () => { try { child.kill('SIGINT'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref(); };
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.once('error', (e) => end(() => reject(new ResticError(e.code === 'ENOENT' ? 'missing_tool' : 'failed', e.code === 'ENOENT' ? 'restic is not installed on this computer.' : e.message))));
    child.once('close', (code) => end(() => {
      if (signal?.aborted) return reject(new ResticError('cancelled', 'Stopped.'));
      if (code === 0) return resolve({ stdout, stderr });
      const [kind, message] = classify(stderr + stdout);
      // The detail is for a person looking at one failure. It never contains the password or an address's sign-in part.
      reject(new ResticError(kind, message, scrub((stderr || stdout).trim().split('\n').slice(-4).join(' | ').slice(0, 500), [password, ...Object.entries(env).filter(([k]) => /PASS|SECRET|TOKEN|KEY/i.test(k)).map(([, v]) => v)])));
    }));
  });
}

const version = (binary = 'restic') => new Promise((resolve) => execFile(binary, ['version'], (e, out) => resolve(e ? null : String(out).trim().split('\n')[0])));
const lines = (text) => String(text).split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('[')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const init = (o) => run(['init', '--quiet'], o);
// Backs up the contents of `dir` (paths inside the snapshot are relative to it). → { snapshot, addedBytes, files }
async function backup(dir, { tags = [], host = 'arvi', limitKiB, ...o }) {
  const args = ['backup', '.', '--json', '--host', host, '--exclude-caches', ...tags.flatMap((t) => ['--tag', t]), ...(limitKiB ? ['--limit-upload', String(limitKiB)] : [])];
  const { stdout } = await run(args, { ...o, cwd: dir });
  const s = lines(stdout).find((e) => e.message_type === 'summary');
  if (!s?.snapshot_id) throw new ResticError('failed', 'The backup tool finished without reporting a snapshot.');
  return { snapshot: s.snapshot_id, addedBytes: s.data_added, files: s.total_files_processed };
}
const snapshots = async ({ tags = [], ...o }) => lines((await run(['snapshots', '--json', ...tags.flatMap((t) => ['--tag', t])], o)).stdout).flat().map((s) => ({ id: s.id, time: s.time, tags: s.tags || [], host: s.hostname }));
// Reads the whole repository back and checks every byte against its checksum.
const check = (o) => run(['check', '--read-data'], o);
const restore = (snapshot, into, o) => run(['restore', snapshot, '--target', into, '--verify'], o);
// What a retention rule would remove. Removes nothing. → { keep: [ids], remove: [ids] }
async function forgetPlan({ tags = [], keepLast, keepWithin, host = 'arvi', ...o }) {
  const rule = [...(keepLast ? ['--keep-last', String(keepLast)] : []), ...(keepWithin ? ['--keep-within', keepWithin] : [])];
  if (!rule.length) throw new ResticError('failed', 'A retention rule is needed.');
  const groups = lines((await run(['forget', '--dry-run', '--json', '--host', host, '--group-by', 'host', ...tags.flatMap((t) => ['--tag', t]), ...rule], o)).stdout).flat();
  return { keep: groups.flatMap((g) => (g.keep || []).map((s) => s.id)), remove: groups.flatMap((g) => (g.remove || []).map((s) => s.id)) };
}
// Removes exactly these snapshots. The space they used is only freed by `prune`, which this module does not expose.
const forget = (ids, o) => (ids.length ? run(['forget', ...ids], o) : Promise.resolve());

module.exports = { ResticError, classify, scrub, run, version, init, backup, snapshots, check, restore, forgetPlan, forget };
