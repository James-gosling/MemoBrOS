// The speech process (an Electron utility process). It owns the native speech runtime (sherpa-onnx with Whisper),
// so a fault in it cannot take the assistant down. One recogniser per model is kept; the language is switched on
// the loaded model instead of loading another copy.
const sherpa = require('sherpa-onnx-node');

const post = (msg) => process.parentPort.postMessage(msg);
const threads = Math.max(1, Math.min(4, Math.floor(require('os').cpus().length / 2)));
const loaded = new Map(); // model id → { rec, language, paths }

const config = (paths, language) => ({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { whisper: { encoder: paths.encoder, decoder: paths.decoder, language, task: 'transcribe', tailPaddings: -1 }, tokens: paths.tokens, numThreads: threads, provider: 'cpu', debug: 0 },
});

process.parentPort.on('message', async ({ data }) => {
  const { id, model, paths, language, pcm } = data;
  if (process.env.MEMOBROS_TEST_STT_CRASH) process.abort(); // test hook: die the way a native fault would
  try {
    let m = loaded.get(model);
    if (!m) {
      post({ model, state: 'initializing' });
      m = { rec: new sherpa.OfflineRecognizer(config(paths, language)), language, paths };
      loaded.set(model, m);
    } else if (m.language !== language) { m.rec.setConfig(config(paths, language)); m.language = language; }
    post({ model, state: 'transcribing' });
    const stream = m.rec.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: pcm instanceof Float32Array ? pcm : new Float32Array(pcm) });
    await m.rec.decodeAsync(stream);
    const r = m.rec.getResult(stream);
    post({ model, state: 'ready' });
    post({ id, text: String(r.text || '').trim(), lang: r.lang || language });
  } catch (e) {
    if (!loaded.has(model)) post({ model, state: 'failed', error: `The model could not be loaded: ${e.message}` });
    else post({ model, state: 'ready' });
    post({ id, error: e.message || String(e) });
  }
});
