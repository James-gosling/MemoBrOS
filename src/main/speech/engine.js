// Main-process side of local speech recognition: starts and supervises the speech process, makes sure the model is
// installed, and applies the language policy.
const path = require('path');
const { app, utilityProcess } = require('electron');
const { getSettings } = require('../store');
const { ModelStore, normalize } = require('./models');
const policy = require('./policy');

const IDLE_MS = 10 * 60 * 1000; // an unused speech process is closed to give its memory back
let store = null, worker = null, nextId = 1, idleTimer = null;
const crashes = [];

const models = () => (store ||= new ModelStore(path.join(app.getPath('userData'), 'speech-models')));
const mainModel = () => normalize(getSettings().sttLocalModel);
const preferred = () => policy.codes(getSettings().voiceLanguages);

function startWorker() {
  const proc = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { stdio: 'pipe', serviceName: 'MemoBrOS speech' });
  const w = { proc, pending: new Map(), doing: 'starting', log: '' };
  const keep = (d) => { w.log = (w.log + d).slice(-600); };
  proc.stdout?.on('data', keep); proc.stderr?.on('data', keep);
  proc.on('message', (msg) => {
    if (msg.state) { w.doing = msg.state; models().runtime(msg.model, msg.state, msg.error); return; }
    const p = w.pending.get(msg.id);
    if (!p) return;
    w.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`Speech recognition failed: ${msg.error}`)); else p.resolve({ text: msg.text, lang: msg.lang });
  });
  proc.on('exit', (code) => {
    if (worker === w) worker = null; // a fresh one is started on the next request
    for (const id of ['tiny', 'base', 'small']) if (['ready', 'transcribing', 'initializing'].includes(models().get(id).state)) models().runtime(id, 'installed');
    if (!w.pending.size) return; // closed on purpose
    crashes.push(Date.now());
    const detail = w.log.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
    for (const p of w.pending.values()) p.reject(new Error(`The on-device speech model stopped unexpectedly while ${w.doing} (exit code ${code}). MemoBrOS keeps running. Try a smaller model in Settings → Voice, or cloud speech recognition.${detail ? ` Details: ${detail}` : ''}`));
    w.pending.clear();
  });
  return w;
}

// One decoding of one phrase with one model in one language ("" lets the model detect it).
async function run(pcm, model, language) {
  const dir = await models().ensure(model); // installs the model first when it is missing; progress goes out as events
  if (crashes.filter((t) => Date.now() - t < 60000).length >= 3) throw new Error('The on-device speech model failed three times in a minute, so it is paused. Choose another model in Settings → Voice, or try again later.');
  if (!worker) worker = startWorker();
  const w = worker;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  void dir;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    w.pending.set(id, { resolve, reject });
    w.proc.postMessage({ id, model, paths: models().paths(model), language, pcm });
  });
}

// A request spoken after a hotkey, or dictation. → { text, lang }
const transcribe = (pcm) => policy.recognize((model, language) => run(pcm, model, language), mainModel(), preferred(), getSettings().language);

// A phrase heard while the wake word is armed. → { command, lang, text } or null
const wake = (pcm, match) => policy.detectWake((model, language) => run(pcm, model, language), { wakeModel: 'tiny', mainModel: mainModel(), preferred: preferred(), match });

function stop() { clearTimeout(idleTimer); if (worker) { const w = worker; worker = null; w.pending.clear(); w.proc.kill(); } }
// After the model choice changes, the old model must not stay in memory.
const modelChanged = () => stop();

module.exports = { models, transcribe, wake, stop, modelChanged, mainModel };
