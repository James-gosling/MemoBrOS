// Wake word. Everything here is local: a speech segment (cut by voice-activity detection in the panel) is
// transcribed on this machine, and only when the transcript starts with the wake word is the rest treated as a
// command. Segments that do not start with it are discarded. Nothing is sent anywhere until a command is found.
const DEFAULT_WORD = 'ARVI';
// How speech recognisers commonly write "ARVI" in Spanish and English.
const SOUNDS_LIKE = { arvi: ['arbi', 'arvy', 'arby', 'arvee', 'arbee', 'harvi', 'harvy', 'harvey', 'harby', 'arvie', 'arbie', 'arví', 'ar vi', 'ar bi', 'r v', 'rv', 'arve', 'arbí'] };

const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; }
  }
  return row[b.length];
}

// Returns { command } when `transcript` starts with the wake word (optionally after "hey"/"oye"/"ok"), else null.
function match(transcript, word = DEFAULT_WORD, extra = []) {
  const w = plain(word);
  if (!w) return null;
  const names = [w, ...(SOUNDS_LIKE[w] || []), ...extra].map(plain).filter(Boolean);
  const text = String(transcript).trim();
  let rest = plain(text).replace(/^(hey|oye|ok|okay|hola|hi) /, '');
  for (const name of names.sort((a, b) => b.length - a.length)) {
    if (rest === name || rest.startsWith(`${name} `)) return { command: cut(text, name.split(' ').length + (plain(text) === rest ? 0 : 1)) };
  }
  const first = rest.split(' ')[0] || '';
  if (w.length >= 4 && first.length >= 3 && distance(first, w) <= 1) return { command: cut(text, 1 + (plain(text) === rest ? 0 : 1)) };
  return null;
}
// Drops the first n words of the original text (keeping its accents and casing) plus leading punctuation.
function cut(text, n) {
  let s = text.trim();
  for (let i = 0; i < n; i++) s = s.replace(/^[^\p{L}\p{N}]*[\p{L}\p{N}]+/u, '');
  return s.replace(/^[^\p{L}\p{N}¿¡]+/u, '').trim();
}

// Commands MemoBrOS handles itself, in Spanish and English, without asking a model.
const LOCAL = [
  ['show', /^(muestra(me)?|ensena(me)?|abre|show( me)?|open|bring up)( la| el| the)? (memobros|memo bros|ventana|panel|window|interfaz)( de memobros)?$/],
  ['hide', /^(oculta|esconde|cierra|hide|close|minimiza|minimize)( la| el| the)? (memobros|memo bros|ventana|panel|window|interfaz)( de memobros)?$/],
  ['stop', /^(para|detente|alto|cancela|stop|cancel|abort)( todo| everything| eso| that)?$/],
  ['mute', /^(deja de escuchar|apaga el microfono|silencia el microfono|stop listening|mute( the)? mic(rophone)?|turn off the mic(rophone)?)$/],
  ['yes', /^(si|claro|adelante|aprobado|aprueba(lo)?|hazlo|dale|yes|approve|go ahead|do it|confirm(ado)?)$/],
  ['no', /^(no|cancela(lo)?|niega(lo)?|deny|reject|don t)$/],
];
const OPEN_APP = /^(?:abre|abrir|inicia|lanza|ejecuta|open|launch|start|run)\s+(.+)$/i;

// → { kind: 'show' | 'hide' | 'stop' | 'mute' | 'yes' | 'no' } | { kind: 'open', app } | { kind: 'ask', text }
function interpret(command) {
  const p = plain(command);
  if (!p) return { kind: 'listen' };
  for (const [kind, re] of LOCAL) if (re.test(p)) return { kind };
  const open = OPEN_APP.exec(command.replace(/[.!?¿¡]+$/g, '').trim());
  if (open && open[1].split(/\s+/).length <= 4 && !/\b(archivo|file|carpeta|folder|pagina|página|page|sitio|site|http)\b/i.test(open[1])) return { kind: 'open', app: open[1].trim() };
  return { kind: 'ask', text: command };
}

// Which language a reply is in, for choosing a voice. Good enough to tell Spanish from English.
function languageOf(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const es = (t.match(/[ñáéíóú¿¡]| (el|la|los|las|que|de|es|en|una?|para|por|con|está|tu|sí|aquí|haz|abre|listo|hecho|no pude|ya) |[a-z]+(ando|iendo|ción|ciones) /g) || []).length;
  const en = (t.match(/ (the|is|are|you|your|to|of|and|it|this|that|here|click|open|with|for) /g) || []).length;
  return es > en ? 'es' : 'en';
}

module.exports = { DEFAULT_WORD, match, interpret, languageOf, plain };
