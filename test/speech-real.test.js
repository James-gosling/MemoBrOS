// Integration test with the REAL speech models inside the real app: download, initialise, transcribe actual audio,
// switch models, restart from cache, and clean up. Needs the fixtures from scripts/fetch-speech-fixtures.sh:
//   MEMOBROS_SPEECH_FIXTURES=<folder> xvfb-run -a node test/speech-real.test.js
// It skips itself when the fixtures are not there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { _electron } = require('playwright');
const fakeModels = require('./fakeModels');

const fixtures = process.env.MEMOBROS_SPEECH_FIXTURES || path.join(__dirname, 'fixtures', 'speech');
if (!fs.existsSync(path.join(fixtures, 'sherpa-onnx-whisper-base.tar.bz2')) || !fs.existsSync(path.join(fixtures, 'wav', 'en1.wav'))) {
  console.log(`SKIP  real speech models (no fixtures in ${fixtures}; see scripts/fetch-speech-fixtures.sh)`);
  process.exit(0);
}
const root = path.join(__dirname, '..');
const electronBin = process.env.MEMOBROS_BIN || require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 16-bit mono WAV → plain array of samples in [-1, 1]
function samples(name) {
  const buf = fs.readFileSync(path.join(fixtures, 'wav', `${name}.wav`));
  const at = buf.indexOf('data') + 8;
  const out = new Array((buf.length - at) >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(at + i * 2) / 32768;
  return out;
}
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push('PASS'); console.log(`PASS  ${name}`); }
  catch (e) { results.push('FAIL'); console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 8).join(' | ')}`); }
};

(async () => {
  const host = await fakeModels.start(fixtures); // serves the real archives locally, so the download path is exercised without the internet
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-speech-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ sttLocalModel: 'base', speak: false, permissions: { screen: true, microphone: true, control: true } }));
  const env = { ...process.env, OPENROUTER_API_KEY: 'x', ANTHROPIC_API_KEY: '', MEMOBROS_USER_DATA: userData, MEMOBROS_TEST: '1', MEMOBROS_MODELS_URL: host.url };
  const launch = async () => {
    const app = await _electron.launch({ executablePath: electronBin, args: [...(process.env.MEMOBROS_BIN ? [] : [root]), '--no-sandbox'], env });
    for (let i = 0; i < 100 && !app.windows().some((w) => w.url().endsWith('panel.html')); i++) await sleep(150);
    const panel = app.windows().find((w) => w.url().endsWith('panel.html'));
    await panel.waitForSelector('.empty');
    await app.evaluate(() => { global.__events = []; global.__memo.stt.engine.models().on('change', (e) => global.__events.push(`${e.model}:${e.state}`)); });
    return { app, panel };
  };
  const transcribe = (app, name) => app.evaluate(async (_e, pcm) => { const t = Date.now(); const text = await global.__memo.stt.transcribe(new Float32Array(pcm)); return { text, ms: Date.now() - t }; }, samples(name));
  const speechProcs = (app) => app.evaluate(({ app: a }) => a.getAppMetrics().filter((m) => m.name === 'MemoBrOS speech').map((m) => ({ pid: m.pid, mb: Math.round(m.memory.workingSetSize / 1024) })));
  const events = (app) => app.evaluate(() => global.__events.filter((s, i, a) => s !== a[i - 1]));
  const invoke = (panel, channel, payload) => panel.evaluate(([c, p]) => window.memo.invoke(c, p), [channel, payload]);

  let { app, panel } = await launch();
  let basePid;
  await check('Base: downloaded, verified, loaded, and it transcribes real English and Spanish speech', async () => {
    assert.equal((await invoke(panel, 'speech:status')).find((m) => m.model === 'base').state, 'not_installed');
    const en = await transcribe(app, 'en1');
    assert.match(en.text, /open visual studio code/i, `English phrase recognised (got: ${en.text})`);
    assert.deepEqual((await events(app)).slice(0, 6), ['base:downloading', 'base:verifying', 'base:installed', 'base:initializing', 'base:transcribing', 'base:ready'], 'every lifecycle stage was reported, in order');
    const es = await transcribe(app, 'es4');
    assert.match(es.text, /hoy vamos a/i); assert.match(es.text, /proyecto/i); assert.match(es.text, /cliente/i);
    assert.ok(!/[฀-๿]/.test(es.text), 'Spanish stays Spanish');
    const procs = await speechProcs(app);
    assert.equal(procs.length, 1, 'one speech process');
    basePid = procs[0].pid;
    console.log(`      base: first phrase ${en.ms} ms including download and load; next phrase ${es.ms} ms; speech process ${procs[0].mb} MB`);
    console.log(`      en1 → "${en.text}"\n      es4 → "${es.text}"`);
    assert.equal((await invoke(panel, 'speech:status')).find((m) => m.model === 'base').state, 'ready');
  });

  await check('Base → Small → Base: the old model is released, Small transcribes, and Base is not downloaded again', async () => {
    await invoke(panel, 'settings:save', { settings: { sttLocalModel: 'small' } });
    await sleep(500);
    assert.equal((await speechProcs(app)).length, 0, 'the speech process holding Base was closed when the model changed');
    assert.equal((await invoke(panel, 'speech:status')).find((m) => m.model === 'base').state, 'installed', 'Base goes back to "downloaded", not left at "ready"');
    const es = await transcribe(app, 'es4');
    assert.match(es.text, /hoy vamos a revisar el estado del proyecto/i, `Small understands the Spanish sentence (got: ${es.text})`);
    const en = await transcribe(app, 'en1');
    assert.match(en.text, /open visual studio code/i);
    const procs = await speechProcs(app);
    assert.ok(procs.length === 1 && procs[0].pid !== basePid);
    console.log(`      small: Spanish sentence ${es.ms} ms including download and load; English phrase ${en.ms} ms; speech process ${procs[0].mb} MB`);
    console.log(`      es4 → "${es.text}"`);
    const before = host.state.requests.length;
    await invoke(panel, 'settings:save', { settings: { sttLocalModel: 'base' } });
    const again = await transcribe(app, 'en1');
    assert.match(again.text, /open visual studio code/i);
    assert.equal(host.state.requests.length, before, 'switching back used the cached Base model');
    const st = await invoke(panel, 'speech:status');
    assert.deepEqual(st.map((m) => `${m.model}:${m.state}`), ['tiny:not_installed', 'base:ready', 'small:installed'], 'no stale state from the model that is no longer loaded');
    console.log(`      back to base from cache: ${again.ms} ms`);
  });

  await check('wake word path on real audio: Tiny listens, the chosen model decodes; silence and noise do nothing', async () => {
    const wake = (name) => app.evaluate(async (_e, pcm) => {
      const m = (t) => global.__memo.wakeMatch(t);
      const t = Date.now(); const hit = await global.__memo.stt.wake(new Float32Array(pcm), m); return { hit, ms: Date.now() - t };
    }, samples(name));
    const first = await wake('en1');
    console.log(`      "Arvi, open Visual Studio Code" (synthetic voice) → ${first.hit ? `heard "${first.hit.text}" (${first.hit.lang}), command "${first.hit.command}"` : 'not recognised as addressed to ARVI'} in ${first.ms} ms incl. Tiny download`);
    assert.ok((await invoke(panel, 'speech:status')).find((m) => m.model === 'tiny').state !== 'not_installed', 'the wake word uses the Tiny model');
    const second = await wake('es4');
    assert.equal(second.hit, null, 'an ordinary sentence is not taken as a command');
    console.log(`      ordinary Spanish sentence ignored in ${second.ms} ms`);
    const silence = await app.evaluate(async () => global.__memo.stt.transcribe(new Float32Array(16000 * 3)));
    const noise = await app.evaluate(async () => { const n = new Float32Array(16000 * 3); for (let i = 0; i < n.length; i++) n[i] = (Math.random() - 0.5) * 0.02; const t = await global.__memo.stt.transcribe(n); return { t, garbled: global.__memo.stt.garbled(t) }; });
    console.log(`      3 s of silence → ${JSON.stringify(silence)}; 3 s of noise → ${JSON.stringify(noise.t)}${noise.garbled ? ' (rejected as invented text)' : ''}`);
    const procs = await speechProcs(app);
    assert.equal(procs.length, 1, 'both models live in one speech process');
    console.log(`      speech process with Tiny + Base loaded: ${procs[0].mb} MB`);
  });

  await check('restart: cached models load without downloading; quitting leaves no speech process behind', async () => {
    await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
    await app.close().catch(() => {});
    await sleep(800);
    const tag = path.basename(userData); // "[m]emobros-…" keeps pgrep from matching its own command line
    const left = execSync(`pgrep -f "[${tag[0]}]${tag.slice(1)}" || true`).toString().trim();
    assert.equal(left, '', 'no process of the closed app is still running');
    const before = host.state.requests.length;
    ({ app, panel } = await launch());
    assert.deepEqual((await invoke(panel, 'speech:status')).map((m) => `${m.model}:${m.state}`), ['tiny:installed', 'base:installed', 'small:installed']);
    const en = await transcribe(app, 'en1');
    assert.match(en.text, /open visual studio code/i);
    assert.equal(host.state.requests.length, before, 'nothing was downloaded after the restart');
    console.log(`      after restart: first phrase ${en.ms} ms (load from disk + transcription)`);
    await invoke(panel, 'speech:remove', { model: 'small' });
    assert.equal((await invoke(panel, 'speech:status')).find((m) => m.model === 'small').state, 'not_installed');
    assert.ok(!fs.existsSync(path.join(userData, 'speech-models', 'whisper-small')));
  });

  await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
  await app.close().catch(() => {});
  host.close();
  const failed = results.filter((r) => r === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
