// Language policy for speech recognition. Pure functions over a `run(model, language)` callback, so they can be
// tested without a model. `language` is a Whisper code ("es", "en") or "" for the model's own detection.
//
// Whisper's detection is unreliable on short phrases (a three-word Spanish phrase was detected as Thai), so its
// answer is only trusted when it names one of the user's languages; otherwise the phrase is decoded again in the
// user's first language. Nothing here ever falls back to English unless English is what the user chose.

// "es-MX, en-US" → ["es", "en"]
const codes = (tags) => [...new Set((tags || []).map((t) => String(t).trim().toLowerCase().split(/[-_]/)[0]).filter(Boolean))];

// One utterance. `choice` is "auto" or a language code picked in Settings.
async function recognize(run, model, preferred, choice) {
  if (choice && choice !== 'auto') { const r = await run(model, choice); return { text: r.text, lang: choice }; }
  const langs = preferred.length ? preferred : ['es', 'en'];
  if (langs.length === 1) { const r = await run(model, langs[0]); return { text: r.text, lang: langs[0] }; }
  const detected = await run(model, '');
  if (langs.includes(detected.lang)) return { text: detected.text, lang: detected.lang };
  const r = await run(model, langs[0]);
  return { text: r.text, lang: langs[0], guessed: true };
}

// Wake word: decode the phrase with the small model once per preferred language and accept the first decoding that
// starts with the wake word. When a larger model is configured, the phrase is decoded again with it, in the language
// that matched, so the command itself is as accurate as possible.
async function detectWake(run, { wakeModel, mainModel, preferred, match }) {
  for (const lang of preferred.length ? preferred : ['es', 'en']) {
    const first = await run(wakeModel, lang);
    const hit = match(first.text);
    if (!hit) continue;
    if (mainModel && mainModel !== wakeModel) {
      const better = await run(mainModel, lang);
      const again = match(better.text);
      if (again) return { command: again.command, lang, text: better.text };
    }
    return { command: hit.command, lang, text: first.text };
  }
  return null;
}

module.exports = { codes, recognize, detectWake };
