// Speech model lifecycle: catalog, download, verification and cache. No Electron here, so it can be tested alone.
//
// A model moves through explicit states, all driven by what actually happened:
//   not_installed → downloading → verifying → installed → initializing → ready ⇄ transcribing
//   with the side exits: interrupted (network), cancelled (user), failed (damaged file, cannot initialise)
// Every operation has a number (`op`); events carry it so a listener can ignore news about an older operation.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

// Multilingual Whisper exported for sherpa-onnx, published as GitHub release assets by the sherpa-onnx project.
const SOURCE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const CATALOG = {
  tiny: { label: 'Tiny', downloadMB: 111, ramMB: 300, note: 'fastest; used for the wake word' },
  base: { label: 'Base', downloadMB: 190, ramMB: 450, note: 'good balance' },
  small: { label: 'Small', downloadMB: 610, ramMB: 900, note: 'most accurate, slower' },
};
const files = (id) => [`${id}-encoder.int8.onnx`, `${id}-decoder.int8.onnx`, `${id}-tokens.txt`];
const archiveDir = (id) => `sherpa-onnx-whisper-${id}`;
const normalize = (id) => (CATALOG[id] ? id : /tiny/i.test(String(id)) ? 'tiny' : /small/i.test(String(id)) ? 'small' : 'base'); // also maps the old "Xenova/whisper-*" names

class Cancelled extends Error { constructor() { super('Cancelled.'); this.cancelled = true; } }

class ModelStore extends EventEmitter {
  constructor(root, source = process.env.MEMOBROS_MODELS_URL || SOURCE) {
    super();
    this.root = root; this.source = source;
    this.status = {};   // id → { model, op, state, received, total, error }
    this.running = {};  // id → { promise, abort } while an install is in progress
    this.ops = 0;
  }
  dir(id) { return path.join(this.root, `whisper-${id}`); }
  part(id) { return path.join(this.root, `${archiveDir(id)}.tar.bz2.part`); }

  // Is a complete copy on disk? Compares every file with the size recorded when it was installed.
  valid(id) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(this.dir(id), 'manifest.json'), 'utf8'));
      return files(id).every((f) => { const m = manifest.files.find((x) => x.name === f); return m && m.size > 0 && fs.statSync(path.join(this.dir(id), f)).size === m.size; });
    } catch { return false; }
  }
  get(id) {
    const s = this.status[id];
    if (s && !['installed', 'ready', 'transcribing', 'initializing'].includes(s.state)) return s;
    if (!this.valid(id)) return this.status[id] = { model: id, op: s?.op || 0, state: fs.existsSync(this.part(id)) ? 'interrupted' : 'not_installed', received: this.partSize(id), total: 0, error: '' };
    return s || (this.status[id] = { model: id, op: 0, state: 'installed', received: 0, total: 0, error: '' });
  }
  all() { return Object.keys(CATALOG).map((id) => ({ ...this.get(id), ...CATALOG[id] })); }
  partSize(id) { try { return fs.statSync(this.part(id)).size; } catch { return 0; } }
  set(id, patch) {
    this.status[id] = { ...(this.status[id] || { model: id, op: 0, received: 0, total: 0 }), error: '', ...patch };
    this.emit('change', { ...this.status[id] });
  }
  // The speech engine reports what the loaded model is doing.
  runtime(id, state, error = '') { if (this.valid(id)) this.set(id, { state, error }); }

  // Resolves with the model folder, installing it first if needed. Calls made while an install runs share it.
  ensure(id) {
    if (!CATALOG[id]) return Promise.reject(new Error(`Unknown speech model "${id}".`));
    if (this.valid(id)) { if (!this.status[id]) this.get(id); return Promise.resolve(this.dir(id)); }
    if (this.running[id]) return this.running[id].promise;
    const abort = new AbortController();
    const op = ++this.ops;
    const promise = this.install(id, op, abort.signal).finally(() => { delete this.running[id]; });
    this.running[id] = { promise, abort };
    return promise;
  }
  cancel(id) { this.running[id]?.abort.abort(); }

  async install(id, op, signal) {
    fs.mkdirSync(this.root, { recursive: true });
    const part = this.part(id);
    try {
      await this.download(id, op, part, signal);
      this.set(id, { op, state: 'verifying' });
      await this.unpack(id, part, signal);
      this.set(id, { op, state: 'installed', received: 0, total: 0 });
      return this.dir(id);
    } catch (e) {
      if (e.cancelled || signal.aborted) { this.set(id, { op, state: 'cancelled', received: this.partSize(id) }); throw new Cancelled(); }
      const state = e.damaged ? 'failed' : 'interrupted';
      this.set(id, { op, state, received: this.partSize(id), error: e.message });
      throw new Error(e.damaged ? e.message : `The download of the ${CATALOG[id].label} speech model was interrupted (${e.message}). It resumes where it stopped when you retry.`);
    }
  }

  // Streams the archive to a ".part" file, continuing a previous partial download when the server allows it.
  async download(id, op, part, signal) {
    let have = this.partSize(id);
    const res = await fetch(`${this.source}/${archiveDir(id)}.tar.bz2`, { signal, redirect: 'follow', headers: have ? { Range: `bytes=${have}-` } : {} });
    if (res.status === 416) { have = 0; fs.rmSync(part, { force: true }); return this.download(id, op, part, signal); } // our partial file no longer matches
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    if (res.status !== 206) have = 0; // the server sent the whole file again
    const total = have + Number(res.headers.get('content-length') || 0);
    this.set(id, { op, state: 'downloading', received: have, total });
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let received = have, last = 0;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        received += chunk.length;
        if (Date.now() - last > 200) { last = Date.now(); this.set(id, { op, state: 'downloading', received, total }); }
      }
    } finally { await new Promise((r) => out.end(r)); }
    if (total && received !== total) throw new Error('the connection closed early');
    this.set(id, { op, state: 'downloading', received, total });
  }

  // Unpacks only the files that are used, checks them, and moves the folder into place in one step.
  async unpack(id, part, signal) {
    const tmp = path.join(this.root, `whisper-${id}.unpacking`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    const damaged = (why) => { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(part, { force: true }); return Object.assign(new Error(`The downloaded ${CATALOG[id].label} speech model was damaged (${why}). It was removed; retry to download it again.`), { damaged: true }); };
    const code = await new Promise((resolve) => {
      const tar = spawn('tar', ['-xjf', part, '-C', tmp, '--strip-components=1', ...files(id).map((f) => `${archiveDir(id)}/${f}`)], { stdio: 'ignore' });
      signal.addEventListener('abort', () => tar.kill(), { once: true });
      tar.on('error', () => resolve(-1)); tar.on('exit', resolve);
    });
    if (signal.aborted) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Cancelled(); }
    if (code !== 0) throw damaged(code === -1 ? 'the "tar" program is missing' : 'it could not be unpacked');
    const manifest = { model: id, installedAt: new Date().toISOString(), files: [] };
    for (const f of files(id)) {
      let size = 0;
      try { size = fs.statSync(path.join(tmp, f)).size; } catch { /* missing */ }
      if (!size) throw damaged(`${f} is missing`);
      manifest.files.push({ name: f, size });
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    fs.renameSync(tmp, this.dir(id));
    fs.rmSync(part, { force: true });
  }

  // Deletes a model the user no longer wants. Never called automatically.
  remove(id) {
    this.cancel(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    fs.rmSync(this.part(id), { force: true });
    this.set(id, { state: 'not_installed', received: 0, total: 0 });
  }
  paths(id) { const [encoder, decoder, tokens] = files(id).map((f) => path.join(this.dir(id), f)); return { encoder, decoder, tokens }; }
}

module.exports = { ModelStore, CATALOG, normalize, files, archiveDir };
