// Runs one command and reports what really happened: exit code, output, how long it took, whether it was
// cancelled or timed out. No Electron here. Works on Linux, macOS and Windows.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const SECRET = /(API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY|COOKIE|(^|_)PAT$|(^|_)DSN$|DATABASE_URL|CONNECTION_STRING)/i;
// The child gets the user's environment minus anything that looks like a credential.
// `keep` (a RegExp or a list of exact names) lets named variables through: an agent's own sign-in, for example.
function cleanEnv(env = process.env, extra = {}, keep = null) {
  const kept = (k) => (keep instanceof RegExp ? keep.test(k) : Array.isArray(keep) && keep.includes(k));
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (!SECRET.test(k) || kept(k))) out[k] = v;
  return { ...out, ...extra };
}

// Windows starts .exe files directly, but tools installed with npm are ".cmd" scripts, which only cmd.exe can
// run - and cmd.exe re-reads its arguments, so passing free text (a task for an agent) through it is unsafe.
// npm's scripts all have the same shape, so the Node program behind one is started directly instead.
// → the words to start, or throws with a reason. Pure: platform, environment and file access are parameters.
function resolveWindows(argv, { env = process.env, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8'), cwd = process.cwd() } = {}) {
  const W = path.win32;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const name = argv[0];
  const hasDir = /[\\/]/.test(name);
  const dirs = hasDir ? [''] : [cwd, ...String(env.Path || env.PATH || '').split(';').filter(Boolean)];
  const names = W.extname(name) ? [name] : exts.map((e) => name + e);
  let found = null;
  for (const d of dirs) { for (const n of names) { const f = d ? W.join(d, n) : n; if (exists(f)) { found = f; break; } } if (found) break; }
  if (!found) return argv; // let the system report it the usual way
  if (!/\.(cmd|bat)$/i.test(found)) return [found, ...argv.slice(1)];
  let script = null;
  try { const m = /"%(?:~dp0|dp0%)\\?([^"]+?\.(?:c?js|mjs))"\s+%\*/i.exec(read(found)); if (m) script = W.join(W.dirname(found), m[1]); } catch { /* unreadable: handled below */ }
  if (script && exists(script)) {
    const local = W.join(W.dirname(found), 'node.exe');
    return [exists(local) ? local : 'node.exe', script, ...argv.slice(1)];
  }
  if (argv.slice(1).every((a) => /^[\w@%+=:,.\/\\-]+$/.test(a) && !a.includes('%'))) return [env.ComSpec || 'cmd.exe', '/d', '/s', '/c', found, ...argv.slice(1)];
  throw new Error(`"${name}" is a Windows batch script (${found}) and these arguments cannot be passed to it safely. Install the program as an .exe, or run it from a plain command.`);
}

// Stops the command and everything it started.
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
}

// opts: { argv | shellLine, cwd, env, timeoutMs = 120000, maxOutput = 200000, signal, onOutput(stream, text), input }
// → { exitCode, signal, stdout, stderr, durationMs, timedOut, cancelled, truncated, error }
function run(opts) {
  const { cwd, timeoutMs = 120000, maxOutput = 200000, signal, onOutput } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    const result = { exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, cancelled: false, truncated: false, error: '' };
    let done = false;
    const finish = () => { if (done) return; done = true; result.durationMs = Date.now() - started; resolve(result); };
    if (signal?.aborted) { result.cancelled = true; return finish(); }
    let child;
    const common = { cwd, env: opts.env || cleanEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] };
    try {
      if (opts.shellLine !== undefined) child = process.platform === 'win32' ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', opts.shellLine], { ...common, windowsVerbatimArguments: true }) : spawn('/bin/sh', ['-c', opts.shellLine], common);
      else { const argv = process.platform === 'win32' ? resolveWindows(opts.argv, { env: common.env, cwd: cwd || process.cwd() }) : opts.argv; child = spawn(argv[0], argv.slice(1), common); }
    } catch (e) { result.error = e.message; return finish(); }
    // Decoders keep a character that arrives split across two chunks whole (accents, emoji).
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const take = (name) => (chunk) => {
      const text = decoders[name].write(chunk);
      if (!text) return;
      try { onOutput?.(name, text); } catch { /* a listener must never break the command */ }
      const room = maxOutput - result.stdout.length - result.stderr.length;
      if (room <= 0) { result.truncated = true; return; }
      result[name] += text.slice(0, room);
      if (text.length > room) result.truncated = true;
    };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    if (opts.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(opts.input); }
    const timer = timeoutMs ? setTimeout(() => { result.timedOut = true; killTree(child); }, timeoutMs) : null;
    const onAbort = () => { result.cancelled = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (e) => { result.error = e.code === 'ENOENT' ? `"${opts.argv ? opts.argv[0] : 'the shell'}" is not installed or not on PATH.` : e.message; });
    child.once('close', (code, sig) => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      for (const name of ['stdout', 'stderr']) { const rest = decoders[name].end(); if (rest) take(name)(Buffer.from(rest)); }
      result.exitCode = code; result.signal = sig;
      finish();
    });
  });
}

// What a model (or a person) should read about a finished command.
function summarize(r, limit = 6000) {
  const clip = (s) => (s.length > limit ? `${s.slice(0, limit / 2)}\n… (${s.length - limit} characters omitted) …\n${s.slice(-limit / 2)}` : s);
  const head = r.error ? `could not start: ${r.error}` : r.cancelled ? 'cancelled before it finished' : r.timedOut ? `stopped after the time limit (${Math.round(r.durationMs / 1000)} s)` : `exit code ${r.exitCode}${r.signal ? ` (signal ${r.signal})` : ''} in ${(r.durationMs / 1000).toFixed(1)} s`;
  return [head, r.stdout.trim() && `stdout:\n${clip(r.stdout.trim())}`, r.stderr.trim() && `stderr:\n${clip(r.stderr.trim())}`, r.truncated && '(output was cut off at the size limit)'].filter(Boolean).join('\n');
}

module.exports = { run, summarize, cleanEnv, killTree, resolveWindows, SECRET };
