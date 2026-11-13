// Recurring routines: scheduled tasks that run in the background, with guardrails.
// A routine is { id, name, task, cron | at, scheduleText, desktop, enabled, plan, allowed[], nextRun, lastRun, history[] }.
const fs = require('fs');
const store = require('./store');
const cron = require('./cron');
const brain = require('./brain');
const mcp = require('./mcp');
const web = require('./webagent');

const APPROVAL_WAIT = 15 * 60 * 1000; // an unanswered approval counts as "no" after this long
const DECLINED = 'The user did not approve this. Do not retry it; carry on without it or finish, and mention it in your report.';
const deps = {};   // { confirm(title, text, opts), notify(title, body), changed(), runDesktop(routine), announce(routine, result) }
let running = null; // { id, abort }

const list = () => store.getRoutines();
const save = (all) => { store.saveRoutines(all); deps.changed?.(); };
const patch = (id, fn) => { const all = list(); const r = all.find((x) => x.id === id); if (r) { fn(r); save(all); } return r; };

function nextRun(r, from = new Date()) {
  if (r.cron) return cron.next(r.cron, from)?.toISOString() || null;
  if (r.at) { const d = new Date(r.at); return d > from ? d.toISOString() : null; }
  return null;
}

// Builds a routine from what the model (or the editor) produced, and refuses anything without a usable schedule.
function fromDraft(d) {
  const r = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: String(d.name || d.task || 'Routine').trim().slice(0, 60),
    task: String(d.task || '').trim(),
    cron: null, at: null, scheduleText: String(d.schedule_text || '').trim(),
    desktop: !!d.needs_screen, enabled: true, plan: d.plan || '', allowed: [], lastRun: null, history: [],
  };
  if (!r.task) throw new Error('The routine needs a task.');
  applySchedule(r, d);
  return r;
}
function applySchedule(r, d) {
  if (d.cron && cron.valid(d.cron)) { r.cron = String(d.cron).trim().split(/\s+/).join(' '); r.at = null; }
  else if (d.run_once_at && !Number.isNaN(new Date(d.run_once_at).getTime())) {
    if (new Date(d.run_once_at) <= new Date()) throw new Error('That time is already in the past.');
    r.at = new Date(d.run_once_at).toISOString(); r.cron = null;
  } else throw new Error("I couldn't work out when to run that. Say a schedule, like \"every Tuesday at 5 PM\".");
  if (d.schedule_text) r.scheduleText = String(d.schedule_text).trim();
  if (!r.scheduleText) r.scheduleText = r.cron || new Date(r.at).toLocaleString();
  r.nextRun = nextRun(r);
}

function add(draft) { const r = fromDraft(draft); save([...list(), r]); return r; }
function remove(id) { if (running?.id === id) running.abort.abort(); save(list().filter((r) => r.id !== id)); }
function setEnabled(id, enabled) { return patch(id, (r) => { r.enabled = !!enabled; r.nextRun = enabled ? nextRun(r) : null; }); }

// Natural language → routine, e.g. "Every Tuesday at 5 PM, check my inbox for invoices".
async function addFromText(text) { return add(await brain.draftRoutine(text)); }

// Editor save. A changed schedule may be plain words (the model converts it) or a raw cron line.
async function update({ id, name, task, scheduleText, desktop }) {
  const current = list().find((r) => r.id === id);
  if (!current) throw new Error('That routine no longer exists.');
  let schedule = null;
  const wanted = String(scheduleText || '').trim();
  if (wanted && wanted !== current.scheduleText) {
    schedule = cron.valid(wanted) ? { cron: wanted, schedule_text: wanted } : await brain.draftRoutine(`${wanted}: ${task || current.task}`);
  }
  return patch(id, (r) => {
    if (name) r.name = String(name).trim().slice(0, 60);
    if (task) r.task = String(task).trim();
    if (desktop !== undefined) r.desktop = !!desktop;
    if (schedule) applySchedule(r, { cron: schedule.cron, run_once_at: schedule.run_once_at, schedule_text: schedule.schedule_text || wanted });
  });
}

// "Chat to routine": one click turns a finished agent task into a daily routine at the current time.
function addFromChat({ task, plan }) {
  const now = new Date();
  const hhmm = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return add({ name: task, task, plan, needs_screen: true, cron: `${now.getMinutes()} ${now.getHours()} * * *`, schedule_text: `Every day at ${hhmm}` });
}

// ---- guardrails -----------------------------------------------------------------------
const ask = (title, text, opts = {}) => deps.confirm(title, text, { timeoutMs: APPROVAL_WAIT, notify: true, ...opts });

// Runs a connected MCP tool, pausing for the user unless it is read-only, trusted or already always-allowed.
async function mcpWithApproval(name, input, who) {
  const t = mcp.find(name);
  if (!t) throw new Error(`No connected tool named ${name}`);
  if (!mcp.preApproved(t)) {
    const answer = await ask(`${who} wants to use ${t.serverName}`, `${t.tool}\n${JSON.stringify(input || {}, null, 1).slice(0, 500)}`, { always: 'Always allow this tool' });
    if (!answer) return DECLINED;
    if (answer === 'always') mcp.alwaysAllow(t);
  }
  return mcp.call(name, input);
}

const REQUEST_APPROVAL = { name: 'request_approval', description: 'Pause and ask the user to approve something hard to undo or that reaches other people (sending, posting, paying, deleting). Returns their answer.', input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
const REMEMBER = { name: 'remember', description: 'Save a short note to long-term memory.', input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } };
const toolset = () => [...web.TOOLS, ...mcp.forModel(), REQUEST_APPROVAL, REMEMBER];

function guardedExec(routine) {
  const who = `Routine "${routine.name}"`;
  const submitOk = async (label) => {
    const key = `submit:${web.origin()}`;
    if ((list().find((r) => r.id === routine.id)?.allowed || []).includes(key)) return true;
    const answer = await ask(`${who} wants to submit a form`, `"${label || 'Submit'}" on ${web.origin()}`, { always: 'Always allow on this site' });
    if (answer === 'always') patch(routine.id, (r) => { r.allowed = [...(r.allowed || []), key]; });
    return !!answer;
  };
  return async (name, i = {}) => {
    switch (name) {
      case 'browser_open': return web.open(String(i.url));
      case 'browser_read': return web.snapshot();
      case 'browser_click': {
        const info = await web.inspect(i.id);
        if (info.submitsForm && info.formSends && !(await submitOk(info.label))) return DECLINED;
        return web.click(i.id);
      }
      case 'browser_type': {
        const info = await web.inspect(i.id);
        if (i.submit && info.formSends && !(await submitOk(info.label))) return DECLINED;
        return web.type(i.id, i.text, !!i.submit);
      }
      case 'list_files': return web.listFiles(i.query);
      case 'browser_upload': {
        const file = web.sharedFile(i.path);
        const origin = web.origin();
        if (!store.getGrants().some((g) => g.path === file && g.origin === origin)) {
          const kb = Math.ceil(fs.statSync(file).size / 1024);
          if (!(await ask(`Upload a file to ${origin.replace(/^https?:\/\//, '')}?`, `${who} wants to upload\n${file} (${kb} KB)\nto ${origin}\n\nYou are asked once per file and site.`))) return DECLINED;
          store.addGrant({ path: file, origin, at: new Date().toISOString() });
        }
        return web.upload(i.id, file);
      }
      case 'request_approval': return (await ask(`${who} needs your OK`, String(i.question))) ? 'The user approved. Go ahead.' : DECLINED;
      case 'remember': store.addMemory(i.note); deps.changed?.(); return 'Saved.';
      default:
        if (name.startsWith('mcp__')) return mcpWithApproval(name, i, who);
        throw new Error(`Unknown tool ${name}`);
    }
  };
}

// ---- running ----------------------------------------------------------------------------
async function run(id) {
  const routine = list().find((r) => r.id === id);
  if (!routine) return null;
  if (running) throw new Error('Another routine is running. Try again when it finishes.');
  running = { id, abort: new AbortController() };
  deps.changed?.();
  let result;
  try {
    if (routine.desktop) result = await deps.runDesktop(routine);
    else result = { status: 'ok', summary: await brain.runRoutine({ routine, tools: toolset(), exec: guardedExec(routine), signal: running.abort.signal }) };
  } catch (e) {
    result = { status: e.aborted ? 'stopped' : 'error', summary: e.message || String(e) };
  }
  running = null;
  const entry = { at: new Date().toISOString(), ...result };
  patch(id, (r) => {
    r.lastRun = entry;
    r.history = [entry, ...(r.history || [])].slice(0, 10);
    r.nextRun = nextRun(r);
    if (!r.nextRun) r.enabled = false; // one-off routines retire after they fire
  });
  deps.announce?.(routine, entry);
  return entry;
}

// A one-off background task started by voice ("check my Gmail for invoices"): same tools and guardrails, no schedule.
async function runOnce(task) {
  if (running) throw new Error('A background task is already running. Try again when it finishes.');
  const job = { id: `once-${Date.now()}`, name: 'Background task', task, desktop: false };
  running = { id: job.id, abort: new AbortController() };
  let result;
  try { result = { status: 'ok', summary: await brain.runRoutine({ routine: job, tools: toolset(), exec: guardedExec(job), signal: running.abort.signal }) }; }
  catch (e) { result = { status: e.aborted ? 'stopped' : 'error', summary: e.message || String(e) }; }
  running = null;
  deps.announce?.(job, { at: new Date().toISOString(), ...result }, true);
  return result;
}

function tick() {
  if (running) return;
  const now = new Date();
  const all = list();
  let dirty = false;
  let due = null;
  for (const r of all) {
    if (!r.enabled) continue;
    if (!r.nextRun) { r.nextRun = nextRun(r, now); dirty = true; continue; }
    const when = new Date(r.nextRun);
    if (when > now) continue;
    if (now - when > 24 * 3600 * 1000) { r.nextRun = nextRun(r, now); dirty = true; continue; } // long-missed run: skip, don't surprise the user
    if (!due) due = r;
  }
  if (dirty) save(all);
  if (due) run(due.id).catch((e) => console.error('routine failed', e));
}

function init(d) {
  Object.assign(deps, d);
  setTimeout(tick, 4000);
  setInterval(tick, 20000);
}
const stop = () => running?.abort.abort();
const view = () => list().map((r) => ({ ...r, running: running?.id === r.id }));

module.exports = { runOnce, init, view, add, addFromText, addFromChat, update, remove, setEnabled, run, stop, tick, mcpWithApproval, fromDraft };
