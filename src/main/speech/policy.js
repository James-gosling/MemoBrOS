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

// Wake word: the small model decodes the phrase once per preferred language, only to find out whether it starts
// with the wake word. Which attempt happens to catch the name says little about the language of the request
// (a Spanish request was once caught by the English attempt and came out as "What was very my pantaya?"), so
// once the name is heard the chosen model listens to the phrase itself and decides, as it does for any request.
async function detectWake(run, { wakeModel, mainModel, preferred, match }) {
  const langs = preferred.length ? preferred : ['es', 'en'];
  for (const lang of langs) {
    const first = await run(wakeModel, lang);
    const hit = match(first.text);
    if (!hit) continue;
    const best = await recognize(run, mainModel || wakeModel, langs, 'auto');
    const again = match(best.text);
    if (again) return { command: again.command, lang: best.lang, text: best.text };
    return { command: hit.command, lang, text: first.text }; // the larger model lost the name: keep the first decoding
  }
  return null;
}

module.exports = { codes, recognize, detectWake };
