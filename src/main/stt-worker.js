// The on-device speech model, in its own process. It runs here, away from the main process, so that a failure of
// the native runtime while loading or running a model cannot take the whole assistant down with it.
// Started by stt.js as an Electron utility process: argv[2] is the folder where models are cached.
const path = require('path');

const cacheDir = process.argv[2];
let loaded = null; // { model, pipe }
const post = (msg) => process.parentPort.postMessage(msg);

async function load(model) {
  if (loaded && loaded.model === model) return loaded.pipe;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(cacheDir, 'models');
  post({ phase: `loading ${model}` });
  const pipe = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    progress_callback: (p) => { if (p.status === 'progress') post({ progress: Math.round(p.progress || 0) }); },
  });
  loaded = { model, pipe };
  return pipe;
}

process.parentPort.on('message', async ({ data }) => {
  const { id, pcm, model, language } = data;
  if (process.env.MEMOBROS_TEST_STT_CRASH) process.abort(); // test hook: die the way a native fault would
  let pipe;
  try { pipe = await load(model); }
  catch (e) { return post({ id, error: `Could not load the on-device speech model "${model}" (${e.message}). It downloads once from huggingface.co; check your connection, or choose another model in Settings → Voice.` }); }
  try {
    post({ phase: 'transcribing' });
    const opts = { task: 'transcribe', chunk_length_s: 30 };
    if (language && language !== 'auto') opts.language = language;
    let out;
    // Whisper can get stuck repeating a phrase on noisy or quiet audio; forbidding repeated word triples stops the loop.
    try { out = await pipe(pcm, { ...opts, no_repeat_ngram_size: 3 }); } catch { out = await pipe(pcm, opts); }
    post({ id, text: (out.text || '').trim() });
  } catch (e) { post({ id, error: `Speech recognition failed: ${e.message}` }); }
});
