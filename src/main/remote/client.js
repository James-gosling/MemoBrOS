// Control-plane side: talks to a MemoBrOS remote worker. No Electron.
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const protocol = require('./protocol');

async function call(worker, method, path, payload, signal) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  let res;
  try { res = await fetch(`${worker.url.replace(/\/$/, '')}${path}`, { method, headers: method === 'GET' ? {} : protocol.headers(worker.secret, method, path, body), body: method === 'GET' ? undefined : body, signal }); }
  catch (e) { if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true }); throw new Error(`Can't reach the worker "${worker.name}" at ${worker.url}: ${e.cause?.code || e.message}`); }
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

const health = async (worker) => (await call(worker, 'GET', '/v1/health')).json;
const newId = () => crypto.randomBytes(8).toString('hex');
// Best effort: tell the worker to stop a job (closing the connection already does; this covers proxies that keep it open).
const cancel = (worker, id) => call(worker, 'POST', '/v1/cancel', { id }).then((r) => r.json.cancelled === true).catch(() => false);

function refuse(worker, status, json) {
  if (status === 401) return new Error(`The worker "${worker.name}" refused the request (${json.error || 'not authorised'}). Check its secret in Settings, and that both clocks are right.`);
  if (status === 403) return Object.assign(new Error(json.error || 'The worker refused this command.'), { denied: true });
  return new Error(`The worker "${worker.name}" answered ${status}: ${json.error || 'unknown error'}`);
}

// Runs a command on the worker. `approved` says the user approved it here.
// With onOutput(stream, text) the output arrives while the command runs.
// → { needsApproval, … } | { id, decision, result } ; throws when refused, unreachable or cut off
async function run(worker, { command, cwd, approved = false, timeoutSec, signal, onOutput }) {
  const id = newId();
  if (!onOutput) {
    const { status, json } = await call(worker, 'POST', '/v1/run', { id, command, cwd, approved, timeoutSec }, signal);
    if (status === 409) return json;
    if (status !== 200) throw refuse(worker, status, json);
    return json;
  }
  const path = '/v1/run', body = JSON.stringify({ id, command, cwd, approved, timeoutSec, stream: true });
  const stopped = () => Object.assign(new Error('Stopped.'), { aborted: true });
  let res;
  try { res = await fetch(`${worker.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: protocol.headers(worker.secret, 'POST', path, body), body, signal }); }
  catch (e) { if (signal?.aborted) throw stopped(); throw new Error(`Can't reach the worker "${worker.name}" at ${worker.url}: ${e.cause?.code || e.message}`); }
  if (res.status !== 200) {
    let json = {};
    try { json = await res.json(); } catch { /* empty body */ }
    if (res.status === 409) return json;
    throw refuse(worker, res.status, json);
  }
  const decoder = new StringDecoder('utf8');
  let pending = '', final = null;
  const take = (text) => {
    pending += text;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type === 'output') { try { onOutput(e.stream, e.text); } catch { /* a listener must not break the run */ } } else if (e.type === 'result') final = e;
    }
  };
  try { for await (const chunk of res.body) take(decoder.write(Buffer.from(chunk))); take(`${decoder.end()}\n`); }
  catch (e) { if (signal?.aborted) { cancel(worker, id); throw stopped(); } throw new Error(`The connection to the worker "${worker.name}" was lost before the command finished (${e.cause?.code || e.message}). The worker stops a command when its connection closes.`); }
  if (!final) throw new Error(`The worker "${worker.name}" closed the connection without reporting a result.`);
  return { id: final.id, decision: final.decision, result: final.result };
}

module.exports = { health, run, cancel, call };
