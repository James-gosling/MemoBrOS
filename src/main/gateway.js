// Kiro Crew gateway adapter.
//
// Kiro Crew is an orchestration gateway: it drives ACP agents itself. It is not an ACP agent, so MemoBrOS never
// speaks ACP to it and never treats its dashboard HTTP endpoint as one. The only interface used here is the
// documented start command, `kirocrew gateway`. This adapter starts that process when the user asks, reports
// whether it is running, and stops it again. It sends the gateway nothing: its stdin is closed.
// MemoBrOS's own crew mode keeps orchestrating Kiro CLI directly, whether or not the gateway runs.
const { spawn } = require('child_process');
const store = require('./store');
const { splitCommand } = require('./mcp');

let child = null;
let info = { state: 'stopped', detail: '', startedAt: null };
let onChange = () => {};

const config = () => ({ command: String(store.getSettings().crewGateway?.command || '').trim() });
const status = () => ({ ...info, command: config().command });
const set = (patch) => { info = { ...info, ...patch }; onChange(); };

function start() {
  if (child) return status();
  const [command, ...args] = splitCommand(config().command);
  if (!command) { set({ state: 'error', detail: 'No gateway command is set.' }); return status(); }
  let tail = '';
  const proc = spawn(command, args, { cwd: store.getSettings().codeAgent?.cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  const keep = (d) => { tail = (tail + d).slice(-400); };
  proc.stdout.on('data', keep); proc.stderr.on('data', keep);
  proc.once('spawn', () => set({ state: 'running', detail: `pid ${proc.pid}`, startedAt: new Date().toISOString() }));
  proc.once('error', (e) => { if (child === proc) child = null; set({ state: 'error', detail: e.code === 'ENOENT' ? `"${command}" is not installed or not on PATH.` : e.message, startedAt: null }); });
  proc.once('exit', (code, signal) => {
    if (child !== proc) return;
    child = null;
    set({ state: signal || code === 0 ? 'stopped' : 'error', detail: signal || code === 0 ? '' : `exited with code ${code}: ${tail.trim().split('\n').slice(-2).join(' | ')}`, startedAt: null });
  });
  return status();
}

function stop() {
  if (!child) return status();
  const proc = child;
  proc.kill();
  setTimeout(() => { if (child === proc) proc.kill('SIGKILL'); }, 4000).unref();
  return status();
}

module.exports = { start, stop, status, init: (changed) => { onChange = changed; } };
