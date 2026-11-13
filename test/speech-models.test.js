// Unit tests for the speech model lifecycle (download, resume, cancel, verify, cache) and the language policy.
// Plain Node against a local HTTP server; no real model is needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const fakeModels = require('./fakeModels');
const { ModelStore, normalize } = require('../src/main/speech/models');
const policy = require('../src/main/speech/policy');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let host, served;
const fresh = () => { const store = new ModelStore(fs.mkdtempSync(path.join(os.tmpdir(), 'models-')), host.url); const events = []; store.on('change', (e) => events.push(e)); host.state.requests.length = 0; host.state.mode = 'ok'; return { store, events }; };
const states = (events) => events.map((e) => e.state).filter((s, i, a) => s !== a[i - 1]);

test('a missing model is downloaded, checked and installed, with honest progress', async () => {
  const { store, events } = fresh();
  assert.equal(store.get('tiny').state, 'not_installed');
  const dir = await store.ensure('tiny');
  assert.deepEqual(states(events), ['downloading', 'verifying', 'installed']);
  const size = fs.statSync(path.join(served, 'sherpa-onnx-whisper-tiny.tar.bz2')).size;
  const progress = events.filter((e) => e.state === 'downloading');
  assert.ok(progress.every((e, i) => e.total === size && (i === 0 || e.received >= progress[i - 1].received)), 'progress only grows and its total is the real file size');
  assert.equal(progress.at(-1).received, size, 'it reaches the full size before the state changes; nothing sits at 98%');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['manifest.json', 'tiny-decoder.int8.onnx', 'tiny-encoder.int8.onnx', 'tiny-tokens.txt'], 'only the files that are used are kept');
  assert.ok(!fs.existsSync(store.part('tiny')), 'no partial file left behind');
  assert.equal(store.valid('tiny'), true);
});

test('a valid cached model is reused without any download, also by a new process', async () => {
  const { store } = fresh();
  await store.ensure('tiny');
  host.state.requests.length = 0;
  await store.ensure('tiny');
  const again = new ModelStore(store.root, host.url); // what a restart of the app sees
  assert.equal(again.get('tiny').state, 'installed');
  await again.ensure('tiny');
  assert.equal(host.state.requests.length, 0);
});

test('two requests for the same model share one download', async () => {
  const { store } = fresh();
  const [a, b] = await Promise.all([store.ensure('tiny'), store.ensure('tiny')]);
  assert.equal(a, b); assert.equal(host.state.requests.length, 1);
});

test('an interrupted download is reported, kept, and resumed from where it stopped', async () => {
  const { store, events } = fresh();
  host.state.mode = 'cut';
  await assert.rejects(store.ensure('tiny'), /was interrupted .* resumes where it stopped/);
  const st = store.get('tiny');
  assert.equal(st.state, 'interrupted'); assert.ok(st.received > 0 && fs.statSync(store.part('tiny')).size === st.received);
  assert.equal(new ModelStore(store.root, host.url).get('tiny').state, 'interrupted', 'a restart still knows about the partial download');
  await store.ensure('tiny');
  assert.equal(host.state.requests[1].range, st.received, 'the retry asks only for the missing part');
  assert.equal(store.valid('tiny'), true);
  assert.deepEqual(states(events), ['downloading', 'interrupted', 'downloading', 'verifying', 'installed']);
});

test('cancelling stops the download at once and a later attempt works', async () => {
  const { store } = fresh();
  host.state.mode = 'slow';
  const pending = store.ensure('tiny');
  await new Promise((r) => setTimeout(r, 200));
  store.cancel('tiny');
  await assert.rejects(pending, (e) => e.cancelled === true);
  assert.equal(store.get('tiny').state, 'cancelled'); assert.equal(store.valid('tiny'), false);
  host.state.mode = 'ok';
  await store.ensure('tiny');
  assert.equal(store.get('tiny').state, 'installed');
});

test('a damaged download is detected, removed and can be retried', async () => {
  const { store } = fresh();
  host.state.mode = 'garbage';
  await assert.rejects(store.ensure('tiny'), /was damaged .*retry to download it again/);
  assert.equal(store.get('tiny').state, 'failed'); assert.ok(!fs.existsSync(store.part('tiny')) && !fs.existsSync(store.dir('tiny')));
  host.state.mode = 'ok';
  await store.ensure('tiny');
  assert.equal(store.valid('tiny'), true);
});

test('an incomplete or altered cache is not trusted', async () => {
  const { store } = fresh();
  const dir = await store.ensure('tiny');
  fs.truncateSync(path.join(dir, 'tiny-decoder.int8.onnx'), 1000);
  assert.equal(store.valid('tiny'), false); assert.equal(store.get('tiny').state, 'not_installed');
  host.state.requests.length = 0;
  await store.ensure('tiny');
  assert.equal(host.state.requests.length, 1, 'it is downloaded again'); assert.equal(store.valid('tiny'), true);
  fs.rmSync(path.join(dir, 'manifest.json'));
  assert.equal(store.valid('tiny'), false, 'files without their manifest are not trusted either');
});

test('each operation is numbered so late events cannot be mistaken for current ones; switching models is independent', async () => {
  const { store, events } = fresh();
  host.state.mode = 'slow';
  const first = store.ensure('tiny');
  await new Promise((r) => setTimeout(r, 150));
  store.cancel('tiny'); await first.catch(() => {});
  host.state.mode = 'ok';
  const [, ] = await Promise.all([store.ensure('tiny'), store.ensure('base')]);
  const ops = (m) => [...new Set(events.filter((e) => e.model === m).map((e) => e.op))];
  assert.equal(ops('tiny').length, 2); assert.ok(ops('tiny')[1] > ops('tiny')[0], 'the retry has a higher number than the cancelled attempt');
  assert.ok(events.filter((e) => e.model === 'base').every((e) => e.op !== ops('tiny')[1]), 'another model never shares an operation number');
  assert.deepEqual([store.get('tiny').state, store.get('base').state], ['installed', 'installed']);
  assert.equal(events.filter((e) => e.model === 'tiny' && e.op === ops('tiny')[0]).at(-1).state, 'cancelled');
});

test('a server error is an interruption with a clear message; removing is explicit; old names map to new ones', async () => {
  const { store } = fresh();
  host.state.mode = 'missing';
  await assert.rejects(store.ensure('base'), /the server answered 404/);
  host.state.mode = 'ok';
  await store.ensure('base');
  store.remove('base');
  assert.equal(store.get('base').state, 'not_installed'); assert.ok(!fs.existsSync(store.dir('base')));
  await assert.rejects(store.ensure('huge'), /Unknown speech model/);
  assert.deepEqual(['Xenova/whisper-tiny', 'Xenova/whisper-base', 'Xenova/whisper-small', 'small', 'nonsense'].map(normalize), ['tiny', 'base', 'small', 'small', 'base']);
});

test('language policy: detection is trusted only for the user\'s languages, and never falls back to English by itself', async () => {
  const calls = [];
  const engine = (answers) => async (model, language) => { calls.push(`${model}:${language || 'detect'}`); return answers[language || 'detect']; };
  assert.deepEqual(policy.codes(['es-MX', 'en-US', 'es-ES']), ['es', 'en']);
  // Spanish detected → used as is, one decoding
  let r = await policy.recognize(engine({ detect: { text: 'abre la ventana', lang: 'es' } }), 'base', ['es', 'en'], 'auto');
  assert.deepEqual([r.text, r.lang, calls.splice(0).join()], ['abre la ventana', 'es', 'base:detect']);
  // English detected → English
  r = await policy.recognize(engine({ detect: { text: 'open the window', lang: 'en' } }), 'base', ['es', 'en'], 'auto');
  assert.equal(r.lang, 'en'); calls.splice(0);
  // a short phrase mis-detected as Thai → decoded again in the first preferred language, not in English
  r = await policy.recognize(engine({ detect: { text: 'คุณ', lang: 'th' }, es: { text: 'oculta la ventana', lang: 'es' } }), 'base', ['es', 'en'], 'auto');
  assert.deepEqual([r.text, r.lang, r.guessed, calls.splice(0).join()], ['oculta la ventana', 'es', true, 'base:detect,base:es']);
  // an explicit choice in Settings is always honoured
  r = await policy.recognize(engine({ es: { text: 'hola', lang: 'es' } }), 'small', ['es', 'en'], 'es');
  assert.deepEqual([r.lang, calls.splice(0).join()], ['es', 'small:es']);
  // one preferred language → no detection at all
  r = await policy.recognize(engine({ es: { text: 'hola', lang: 'es' } }), 'base', ['es'], 'auto');
  assert.equal(calls.splice(0).join(), 'base:es');
});

test('wake word: the small model listens in each preferred language; the chosen model decodes the command', async () => {
  const wake = require('../src/main/wake');
  const calls = [];
  const run = (answers) => async (model, language) => { calls.push(`${model}:${language}`); return { text: answers[`${model}:${language}`] || '', lang: language }; };
  const match = (t) => wake.match(t, 'ARVI');
  let hit = await policy.detectWake(run({ 'tiny:es': 'Arbi abre visual estudio cod', 'base:es': 'ARVI, abre Visual Studio Code.' }), { wakeModel: 'tiny', mainModel: 'base', preferred: ['es', 'en'], match });
  assert.deepEqual([hit.command, hit.lang, calls.splice(0).join()], ['abre Visual Studio Code.', 'es', 'tiny:es,base:es'], 'found in Spanish, command refined by the larger model');
  hit = await policy.detectWake(run({ 'tiny:es': 'a ver jai de window', 'tiny:en': 'RV, hide the window' }), { wakeModel: 'tiny', mainModel: 'tiny', preferred: ['es', 'en'], match });
  assert.deepEqual([hit.command, hit.lang, calls.splice(0).join()], ['hide the window', 'en', 'tiny:es,tiny:en'], 'found in English on the second try; no second model when Tiny is the chosen one');
  hit = await policy.detectWake(run({ 'tiny:es': 'vamos a comer', 'tiny:en': 'we are going to eat' }), { wakeModel: 'tiny', mainModel: 'small', preferred: ['es', 'en'], match });
  assert.deepEqual([hit, calls.splice(0).join()], [null, 'tiny:es,tiny:en'], 'ordinary speech never reaches the large model');
  hit = await policy.detectWake(run({ 'tiny:es': 'Arvi oculta la ventana', 'base:es': 'y oculta la ventana' }), { wakeModel: 'tiny', mainModel: 'base', preferred: ['es'], match });
  assert.equal(hit.command, 'oculta la ventana', 'if the larger model loses the wake word, the first decoding is used');
});

(async () => {
  served = fs.mkdtempSync(path.join(os.tmpdir(), 'served-'));
  fakeModels.fakeArchive(served, 'tiny'); fakeModels.fakeArchive(served, 'base');
  host = await fakeModels.start(served);
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
  }
  host.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
