// Speech-to-text. Input is 16 kHz mono Float32 PCM captured in the panel renderer.
//  - local: Whisper running on-device through transformers.js (multilingual, no key; model downloads on first use)
//  - cloud: any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, ...)
const path = require('path');
const { app } = require('electron');
const { getSettings, getSecret } = require('./store');

let localAsr = null; // { model, pipe }

async function localTranscribe(pcm, language, onProgress) {
  const s = getSettings();
  if (!localAsr || localAsr.model !== s.sttLocalModel) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(app.getPath('userData'), 'models');
    let pipe;
    try {
      pipe = await pipeline('automatic-speech-recognition', s.sttLocalModel, {
        dtype: 'q8',
        progress_callback: (p) => { if (p.status === 'progress' && onProgress) onProgress(Math.round(p.progress || 0)); },
      });
    } catch (e) {
      throw new Error(`Could not load the on-device speech model "${s.sttLocalModel}" (${e.message}). It downloads once from huggingface.co; check your connection, or switch to cloud speech recognition in Settings.`);
    }
    localAsr = { model: s.sttLocalModel, pipe };
  }
  const opts = { task: 'transcribe', chunk_length_s: 30 };
  if (language && language !== 'auto') opts.language = language;
  let out;
  // Whisper can get stuck repeating a phrase on noisy or quiet audio; forbidding repeated word triples stops the loop.
  try { out = await localAsr.pipe(pcm, { ...opts, no_repeat_ngram_size: 3 }); }
  catch { out = await localAsr.pipe(pcm, opts); }
  return (out.text || '').trim();
}

function wav(pcm) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return buf;
}

async function cloudTranscribe(pcm, language) {
  const s = getSettings();
  const key = getSecret('stt');
  if (!key) throw new Error('Cloud speech-to-text needs an API key. Add one in Settings, or switch speech recognition to "On-device Whisper".');
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', s.sttCloudModel);
  if (language && language !== 'auto') form.append('language', language);
  const res = await fetch(`${s.sttBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`Speech-to-text failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()).text || '').trim();
}

// Speech models invent text when they are given noise, silence or a faint voice: a phrase repeated over and over, or
// stock lines from their training data. Such a transcript must never be acted on as if the user had said it.
const STOCK = /^(thank you( very much| so much)?|thanks( for watching)?|you|bye|okay|gracias( por ver( el video)?)?|subt[ií]tulos (realizados )?por la comunidad de amara\.org|subtitles by the amara\.org community|\[.*\]|\(.*\)|♪.*|\.+)[.!]*$/i;
function garbled(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (STOCK.test(t)) return true;
  const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 9) return false;
  const triples = [];
  for (let i = 0; i + 2 < words.length; i++) triples.push(words.slice(i, i + 3).join(' '));
  if (new Set(triples).size / triples.length < 0.6) return true; // the same few words going round and round
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Math.max(...Object.values(counts)) / words.length > 0.45; // one word making up almost half of it
}

// opts.localOnly: never use a cloud service for this audio (wake-word listening).
async function transcribe(pcm, onProgress, opts = {}) {
  if (process.env.MEMOBROS_FAKE_TRANSCRIPT_FILE) { try { return require('fs').readFileSync(process.env.MEMOBROS_FAKE_TRANSCRIPT_FILE, 'utf8').trim(); } catch { return ''; } } // test hook
  if (process.env.MEMOBROS_FAKE_TRANSCRIPT) return process.env.MEMOBROS_FAKE_TRANSCRIPT; // test hook
  const s = getSettings();
  if (opts.localOnly) return localTranscribe(pcm, s.language, onProgress);
  return s.sttProvider === 'cloud' ? cloudTranscribe(pcm, s.language) : localTranscribe(pcm, s.language, onProgress);
}

module.exports = { transcribe, garbled };
