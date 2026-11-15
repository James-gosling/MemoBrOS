// Control-plane side: talks to a MemoBrOS remote worker. No Electron.
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

// Runs a command on the worker. `approved` says the user approved it here. → { needsApproval, … } | { result } ; throws when refused
async function run(worker, { command, cwd, approved = false, timeoutSec, signal }) {
  const { status, json } = await call(worker, 'POST', '/v1/run', { command, cwd, approved, timeoutSec }, signal);
  if (status === 409) return json;
  if (status === 401) throw new Error(`The worker "${worker.name}" refused the request (${json.error}). Check its secret in Settings.`);
  if (status === 403) throw Object.assign(new Error(json.error), { denied: true });
  if (status !== 200) throw new Error(`The worker "${worker.name}" answered ${status}: ${json.error || 'unknown error'}`);
  return json;
}

module.exports = { health, run, call };
