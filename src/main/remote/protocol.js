// How the control plane (MemoBrOS) and a remote worker authenticate each other's messages.
// Every request carries a timestamp, a one-time nonce and an HMAC-SHA256 of "timestamp.nonce.method.path.body"
// keyed with a secret both sides hold. The secret itself is never sent. Stale or repeated requests are refused.
const crypto = require('crypto');

const WINDOW_MS = 60000;
const sign = (secret, ts, nonce, method, path, body) => crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${method}.${path}.${body}`).digest('hex');

function headers(secret, method, path, body) {
  const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString('hex');
  return { 'content-type': 'application/json', 'x-memobros-timestamp': ts, 'x-memobros-nonce': nonce, 'x-memobros-signature': sign(secret, ts, nonce, method, path, body) };
}

// → null when the request is authentic and fresh, otherwise why not. `seen` is the worker's set of used nonces.
function verify(secret, req, body, seen) {
  const ts = req.headers['x-memobros-timestamp'], nonce = req.headers['x-memobros-nonce'], sig = String(req.headers['x-memobros-signature'] || '');
  if (!ts || !nonce || !sig) return 'unsigned request';
  if (Math.abs(Date.now() - Number(ts)) > WINDOW_MS) return 'stale request';
  if (seen.has(nonce)) return 'repeated request';
  const want = sign(secret, ts, nonce, req.method, req.url, body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return 'bad signature';
  seen.add(nonce);
  setTimeout(() => seen.delete(nonce), WINDOW_MS * 2).unref();
  return null;
}

module.exports = { headers, verify, sign, WINDOW_MS };
