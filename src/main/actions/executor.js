// Runs one command and reports what really happened: exit code, output, how long it took, whether it was
// cancelled or timed out. No Electron here. Works on Linux, macOS and Windows.
const { spawn, execFile } = require('child_process');

const SECRET = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i;
// The child gets the user's environment minus anything that looks like a credential.
function cleanEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET.test(k)) out[k] = v;
  return { ...out, ...extra };
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
    const finish = () => { result.durationMs = Date.now() - started; resolve(result); };
    if (signal?.aborted) { result.cancelled = true; return finish(); }
    let child;
    const common = { cwd, env: opts.env || cleanEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] };
    try {
      if (opts.shellLine !== undefined) child = process.platform === 'win32' ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', opts.shellLine], { ...common, windowsVerbatimArguments: true }) : spawn('/bin/sh', ['-c', opts.shellLine], common);
      else child = spawn(opts.argv[0], opts.argv.slice(1), common);
    } catch (e) { result.error = e.message; return finish(); }
    const take = (name) => (chunk) => {
      const text = chunk.toString('utf8');
      onOutput?.(name, text);
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

module.exports = { run, summarize, cleanEnv, killTree };
