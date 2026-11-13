// A local stand-in for the model download host. Serves "<name>.tar.bz2" archives from a folder (real ones when
// present, otherwise small fakes it builds), with Range support and switchable failure modes.
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

// Builds a fake archive with the same layout as the real one: the three used files plus one that is not used.
function fakeArchive(dir, id, bytes = 300000) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-model-'));
  const inner = path.join(work, `sherpa-onnx-whisper-${id}`);
  fs.mkdirSync(inner);
  for (const f of [`${id}-encoder.int8.onnx`, `${id}-decoder.int8.onnx`, `${id}-tokens.txt`, `${id}-encoder.onnx`]) fs.writeFileSync(path.join(inner, f), require('crypto').randomBytes(bytes));
  execFileSync('tar', ['-cjf', path.join(dir, `sherpa-onnx-whisper-${id}.tar.bz2`), '-C', work, `sherpa-onnx-whisper-${id}`]);
  fs.rmSync(work, { recursive: true, force: true });
}

function start(dir) {
  const state = { requests: [], mode: 'ok', sent: 0 }; // mode: ok | cut (drop the connection half way, once) | slow | garbage | missing
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(req.url));
    const range = /bytes=(\d+)-/.exec(req.headers.range || '');
    state.requests.push({ url: req.url, range: range ? Number(range[1]) : null });
    if (state.mode === 'missing' || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    let body = state.mode === 'garbage' ? Buffer.alloc(200000, 7) : fs.readFileSync(file);
    const from = range ? Number(range[1]) : 0;
    if (from >= body.length) { res.writeHead(416); return res.end(); }
    res.writeHead(range ? 206 : 200, { 'content-length': body.length - from, 'accept-ranges': 'bytes' });
    body = body.subarray(from);
    if (state.mode === 'cut') { state.mode = 'ok'; res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.destroy()); state.sent += Math.floor(body.length / 2); return; }
    if (state.mode === 'slow') { // a few kilobytes at a time, so a test can cancel in the middle
      let i = 0;
      const tick = () => { if (res.destroyed) return; if (i >= body.length) return res.end(); res.write(body.subarray(i, i + 16384)); i += 16384; state.sent += 16384; setTimeout(tick, 30); };
      return tick();
    }
    state.sent += body.length;
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

module.exports = { fakeArchive, start };
