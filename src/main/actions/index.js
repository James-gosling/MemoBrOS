// The local action executor as the app uses it: permission, policy, approval, execution, audit trail.
// Every command goes through here, whoever asks for it (a chat request, a routine, a crew worker).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('../store');
const policy = require('./policy');
const executor = require('./executor');
const remote = require('../remote/client');

const deps = {}; // { allowed(name), confirm(title, text, opts), toPanel(event), activity(patch) }
const init = (d) => Object.assign(deps, d);

// Folders commands may run in: the project folder, plus any the user added.
function roots() {
  const s = store.getSettings();
  return [...new Set([s.codeAgent?.cwd, ...(s.actions.roots || [])].filter(Boolean))];
}
// One line per decision and result, kept on this computer.
function audit(entry) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'actions.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* the log must never break an action */ }
}

// Shows a running command's output in the panel as it arrives, in small batches so a chatty command cannot flood it.
let liveSeq = 0;
function live(label) {
  const id = `out${++liveSeq}`;
  let buf = '', timer = null, sent = 0;
  const flush = () => {
    timer = null;
    if (!buf) return;
    const text = buf.slice(0, Math.max(0, 60000 - sent)); // the panel keeps the tail; this bounds what is sent at all
    sent += text.length; buf = '';
    if (text) deps.toPanel({ type: 'output', id, label, text });
  };
  return {
    onOutput: (_stream, text) => { buf += text; if (!timer) timer = setTimeout(flush, 120); },
    end: () => { clearTimeout(timer); flush(); deps.toPanel({ type: 'output', id, done: true }); },
  };
}

// A remote worker the user configured, with its secret. → null when there is none by that name.
function worker(name) {
  const w = (store.getSettings().actions.workers || []).find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.id === name);
  return w ? { ...w, secret: store.getSecret(`worker:${w.id}`) } : null;
}

// The same flow on another machine: the worker applies its own policy; approval still happens here, with the user.
async function runRemote(w, { command, cwd, why, who, signal, confirmOpts }) {
  const record = { who, command, cwd: cwd || '', worker: w.name };
  let res;
  const view = live(`${w.name} $ ${command}`);
  try {
    res = await remote.run(w, { command, cwd, signal });
    if (res.needsApproval) {
      const text = [command, `\nOn the worker "${w.name}" (${w.url})`, `Folder: ${res.cwd}`, why && `Why: ${why}`, res.risk && `Careful: ${res.risk}.`, res.shell && 'This line uses shell features (pipes, redirects or similar).'].filter(Boolean).join('\n');
      if (!(await deps.confirm(`${who} wants to run a command on ${w.name}`, text, confirmOpts))) { audit({ ...record, decision: 'declined by user' }); return 'Not run: the user did not approve this command. Do not retry it; carry on without it or ask what they want instead.'; }
      deps.toPanel({ type: 'message', role: 'action', text: `${w.name} $ ${command}` });
      res = await remote.run(w, { command, cwd, approved: true, signal, onOutput: view.onOutput });
    } else { deps.toPanel({ type: 'message', role: 'action', text: `${w.name} $ ${command}` }); if (res.result) view.onOutput('stdout', `${res.result.stdout}${res.result.stderr}`); }
    view.end();
  } catch (e) {
    view.end();
    if (e.aborted) { audit({ ...record, decision: 'cancelled' }); throw e; }
    audit({ ...record, decision: e.denied ? 'denied by worker policy' : 'worker error', reason: e.message });
    return e.denied ? `Not run. ${e.message} Do not try to get around this; tell the user.` : `Not run: ${e.message}`;
  }
  const r = res.result;
  audit({ ...record, decision: res.decision, exitCode: r.exitCode, durationMs: r.durationMs, cancelled: r.cancelled, timedOut: r.timedOut });
  const out = executor.summarize(r);
  deps.toPanel({ type: 'message', role: 'action', text: `${w.name}: ${out.split('\n')[0]}` });
  return out;
}

// → text for whoever asked: the real outcome, or why the command did not run.
async function runCommand({ command, cwd, why = '', who = 'Memo', signal, confirmOpts = {}, worker: workerName }) {
  command = String(command || '').trim();
  if (!(await deps.allowed('commands'))) return 'Not run: the user has not allowed MemoBrOS to run commands.';
  if (workerName) {
    const w = worker(workerName);
    if (!w) return `Not run: there is no remote worker called "${workerName}". Configured workers: ${(store.getSettings().actions.workers || []).map((x) => x.name).join(', ') || 'none'}.`;
    return runRemote(w, { command, cwd, why, who, signal, confirmOpts });
  }
  const s = store.getSettings();
  const d = policy.decide(command, cwd || roots()[0], { roots: roots(), allow: s.actions.allow });
  const record = { who, command, cwd: d.cwd || cwd || '' };
  if (d.decision === 'deny') {
    audit({ ...record, decision: 'denied by policy', reason: d.reason });
    deps.toPanel({ type: 'message', role: 'action', text: `Refused: ${command.slice(0, 80)}` });
    return `Not run. ${d.reason} Do not try to get around this; tell the user.`;
  }
  if (d.decision === 'ask') {
    const text = [command, `\nFolder: ${d.cwd}`, why && `Why: ${why}`, d.risk && `Careful: ${d.risk}.`, d.shell && 'This line uses shell features (pipes, redirects or similar).'].filter(Boolean).join('\n');
    const answer = await deps.confirm(`${who} wants to run a command`, text, { ...confirmOpts, always: d.rule ? `Always allow "${d.rule}"` : '' });
    if (!answer) { audit({ ...record, decision: 'declined by user' }); return 'Not run: the user did not approve this command. Do not retry it; carry on without it or ask what they want instead.'; }
    if (answer === 'always') store.saveSettings({ actions: { allow: [...new Set([...(s.actions.allow || []), d.rule])] } });
  }
  deps.toPanel({ type: 'message', role: 'action', text: `$ ${command}` });
  deps.activity({ control: true });
  let r;
  const view = live(`$ ${command}`);
  try {
    r = await executor.run({ ...(d.shell ? { shellLine: command } : { argv: d.argv }), cwd: d.cwd, timeoutMs: (s.actions.timeoutSec || 120) * 1000, signal, onOutput: view.onOutput });
  } finally { view.end(); deps.activity({ control: false }); }
  audit({ ...record, decision: d.decision === 'allow' ? 'allowed by rule' : 'approved by user', exitCode: r.exitCode, durationMs: r.durationMs, cancelled: r.cancelled, timedOut: r.timedOut, error: r.error || undefined });
  const out = executor.summarize(r);
  deps.toPanel({ type: 'message', role: 'action', text: out.split('\n')[0] });
  return out;
}

const TOOL = {
  name: 'run_command',
  description: 'Run one command on the user\'s computer, in their project folder, and get its real exit code and output. The user sees the exact command and approves it unless they already allowed that kind of command. Some commands are never run (administrator rights, disk tools, deleting system or home folders). Prefer plain commands; pipes and redirects always need approval.',
  input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command line, e.g. "git status" or "npm test"' }, cwd: { type: 'string', description: 'Folder to run in; defaults to the project folder and must be inside it' }, why: { type: 'string', description: 'A few words the user will read when deciding' }, worker: { type: 'string', description: 'Only if the user asked to run it on one of their remote workers: that worker\'s name. Leave out to run on this computer.' } }, required: ['command'] },
};

module.exports = { init, runCommand, roots, worker, TOOL };
